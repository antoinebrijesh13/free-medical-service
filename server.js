const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const MAX_ALLOWED = parseInt(process.env.MAX_ALLOWED || '20', 10);
const DEFAULT_POOL_OPTS = {
  user: process.env.DB_USER || 'clinic',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'clinicdb',
  password: process.env.DB_PASSWORD || 'clinicpass',
  port: Number(process.env.DB_PORT) || 5432,
};

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.DB_SSL === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
      }
    : DEFAULT_POOL_OPTS
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

pool
  .query('SELECT NOW()')
  .then(() => {
    console.log('Database connected successfully');
  })
  .catch((err) => {
    console.error('Database connection error:', err);
  });

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function formatToken(id) {
  return `T${id}`;
}

async function getAllowedPatients(client) {
  const { rows } = await client.query(
    `SELECT * FROM tokens
     WHERE status = 'allowed'
     ORDER BY admitted_at ASC NULLS FIRST, id ASC
     LIMIT $1`,
    [MAX_ALLOWED]
  );
  return rows;
}

async function makeRoomFor(client, slotsNeeded) {
  const tokensFinished = [];

  while (slotsNeeded > 0) {
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM tokens
       WHERE status = 'allowed'`
    );
    const allowedCount = countRes.rows[0].count;

    if (allowedCount < MAX_ALLOWED) {
      break;
    }

    const oldestRes = await client.query(
      `UPDATE tokens
       SET status = 'done', finished_at = NOW()
       WHERE id = (
         SELECT id FROM tokens
         WHERE status = 'allowed'
         ORDER BY admitted_at ASC NULLS FIRST, id ASC
         LIMIT 1
       )
       RETURNING token`
    );

    if (!oldestRes.rows.length) {
      break;
    }

    tokensFinished.push(oldestRes.rows[0].token);
    slotsNeeded -= 1;
  }

  return tokensFinished;
}

async function setPatientAllowed(client, token) {
  const normalizedToken = token.trim().toUpperCase();
  const patientRes = await client.query(
    `SELECT * FROM tokens
     WHERE token = $1
     FOR UPDATE`,
    [normalizedToken]
  );

  if (!patientRes.rows.length) {
    return { notFound: true };
  }

  const patient = patientRes.rows[0];

  if (patient.status === 'done') {
    return { notFound: true };
  }

  if (patient.status === 'allowed') {
    return { patient, tokensFinished: [] };
  }

  const tokensFinished = await makeRoomFor(client, 1);

  const updateRes = await client.query(
    `UPDATE tokens
     SET status = 'allowed', admitted_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [patient.id]
  );

  return { patient: updateRes.rows[0], tokensFinished };
}

async function nextIdentity(client) {
  const seqRes = await client.query(
    `SELECT pg_get_serial_sequence('tokens', 'id') AS seq_name`
  );
  const sequenceName = seqRes.rows[0]?.seq_name;

  if (!sequenceName) {
    throw new Error('Unable to resolve sequence for tokens.id');
  }

  const { rows: initialCountRows } = await client.query(
    `SELECT COUNT(*)::int AS count FROM tokens`
  );
  const initialCount = Number(initialCountRows[0].count) || 0;

  if (initialCount === 0) {
    await client.query('SELECT pg_advisory_xact_lock(42, 0)');

    const { rows: confirmRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM tokens`
    );

    const confirmCount = Number(confirmRows[0].count) || 0;

    if (confirmCount === 0) {
      await client.query(`SELECT setval($1::regclass, 1, false)`, [sequenceName]);
    }
  }

  const { rows } = await client.query(
    `SELECT nextval($1::regclass) AS id`,
    [sequenceName]
  );
  return rows[0].id;
}

// ============ API ENDPOINTS ============

app.post('/api/checkin', async (req, res) => {
  const { name, age, country, details } = req.body || {};

  if (!name || !country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ageNumber = Number(age);
  if (!Number.isFinite(ageNumber) || ageNumber < 0) {
    return res.status(400).json({ error: 'Invalid age' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const nextId = await nextIdentity(client);
    const token = formatToken(nextId);

    const insertRes = await client.query(
      `INSERT INTO tokens (id, token, name, age, country, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'waiting')
       RETURNING *`,
      [
        nextId,
        token,
        name.trim(),
        ageNumber,
        country.trim(),
        (details || '').trim() || null,
      ]
    );

    const inserted = insertRes.rows[0];

    await client.query('COMMIT');

    const patient = inserted;
    io.emit('new-patient', patient);

    res.json({
      success: true,
      token,
      patient,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Check-in failed' });
  } finally {
    client.release();
  }
});

app.get('/api/patients', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM tokens
       WHERE status != 'done'
       ORDER BY id ASC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching patients:', error);
    res.status(500).json({ error: 'Failed to fetch patients' });
  }
});

app.get('/api/allowed', async (req, res) => {
  try {
    const allowed = await getAllowedPatients(pool);
    res.json(allowed);
  } catch (error) {
    console.error('Error fetching allowed patients:', error);
    res.status(500).json({ error: 'Failed to fetch allowed patients' });
  }
});

app.post('/api/admit/:token', async (req, res) => {
  const { token } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { patient, tokensFinished, notFound } = await setPatientAllowed(
      client,
      token
    );

    if (notFound) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Patient not found' });
    }

    const allowed = await getAllowedPatients(client);

    await client.query('COMMIT');

    tokensFinished.forEach((finishedToken) => {
      io.emit('patient-finished', finishedToken);
    });
    io.emit('allowed-update', allowed);

    res.json({ success: true, patient });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admit error:', error);
    res.status(500).json({ error: 'Failed to admit patient' });
  } finally {
    client.release();
  }
});

app.post('/api/remove/:token', async (req, res) => {
  const { token } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalizedToken = token.trim().toUpperCase();
    const currentRes = await client.query(
      `SELECT status
       FROM tokens
       WHERE token = $1
       FOR UPDATE`,
      [normalizedToken]
    );

    if (!currentRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Patient not found' });
    }

    const wasAllowed = currentRes.rows[0].status === 'allowed';

    await client.query(
      `UPDATE tokens
       SET status = 'done', finished_at = NOW()
       WHERE token = $1`,
      [normalizedToken]
    );

    const allowed = await getAllowedPatients(client);

    await client.query('COMMIT');

    if (wasAllowed) {
      io.emit('patient-finished', normalizedToken);
      io.emit('allowed-update', allowed);
    }

    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Remove error:', error);
    res.status(500).json({ error: 'Failed to remove patient' });
  } finally {
    client.release();
  }
});

app.post('/api/next', async (req, res) => {
  const { count, num } = req.body || {};
  const requested = Number.isInteger(count)
    ? count
    : Number.isInteger(num)
    ? num
    : 5;

  if (requested <= 0) {
    return res.status(400).json({ error: 'Count must be positive' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const waitingRes = await client.query(
      `SELECT token
       FROM tokens
       WHERE status = 'waiting'
       ORDER BY id ASC
       LIMIT $1`,
      [requested]
    );

    if (!waitingRes.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ success: true, message: 'No waiting patients' });
    }

    const promoted = [];
    const finishedTokens = [];

    for (const row of waitingRes.rows) {
      const { patient, tokensFinished, notFound } = await setPatientAllowed(
        client,
        row.token
      );

      if (!notFound && patient) {
        promoted.push(patient);
      }
      finishedTokens.push(...tokensFinished);
    }

    const allowed = await getAllowedPatients(client);

    await client.query('COMMIT');

    finishedTokens.forEach((finishedToken) => {
      io.emit('patient-finished', finishedToken);
    });
    io.emit('allowed-update', allowed);

    res.json({
      success: true,
      admitted: promoted.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Next patients error:', error);
    res.status(500).json({ error: 'Failed to admit next patients' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
