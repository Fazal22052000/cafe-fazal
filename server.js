const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

// ✅ Serve HTML files from same folder as server.js
app.use(express.static(path.join(__dirname)));

// ✅ Middleware
app.use(cors({ origin: "*", methods: ["GET","POST","PATCH","DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// ✅ PostgreSQL Connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'cafefazal',
  password: 'postgres',
  port: 5432,
});

pool.connect((err, client, release) => {
  if (err) { console.error('❌ Database connection FAILED:', err.message); }
  else { console.log('✅ Connected to PostgreSQL'); release(); }
});

// ✅ Add all columns + new tables on startup
pool.query(`
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT '';
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
`).then(() => console.log('✅ Reservations table columns verified'))
  .catch(err => console.error('⚠ Column check (may be harmless):', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(100), last_name VARCHAR(100),
    phone VARCHAR(30), email VARCHAR(150),
    date DATE, time VARCHAR(20), guests VARCHAR(10),
    occasion VARCHAR(100), dietary VARCHAR(100), request TEXT,
    status VARCHAR(20) DEFAULT 'waiting',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('✅ Waitlist table ready'))
  .catch(err => console.error('⚠ Waitlist table:', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS blackout_dates (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    reason TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('✅ Blackout dates table ready'))
  .catch(err => console.error('⚠ Blackout table:', err.message));


pool.query(`
  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(150) DEFAULT '',
    email      VARCHAR(200) UNIQUE NOT NULL,
    subscribed_at TIMESTAMP DEFAULT NOW(),
    active     BOOLEAN DEFAULT TRUE
  );
`).then(() => console.log('\u2705 Newsletter subscribers table ready'))
  .catch(err => console.error('\u26a0 Newsletter table:', err.message));



// ─────────────────────────────────────────
//  ADMIN AUTH
//  POST /admin/login  { password }
//  GET  /admin/verify (header: x-admin-token)
// ─────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Fazal@2000';

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD).toString('base64') });
  } else {
    res.status(401).json({ success: false, error: 'Incorrect password.' });
  }
});

app.get('/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  const valid  = token === Buffer.from(ADMIN_PASSWORD).toString('base64');
  res.json({ valid });
});

// ─────────────────────────────────────────
//  TEST ROUTE
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: '✅ Cafe Fazal server is running!', time: new Date() });
});

// ─────────────────────────────────────────
//  CUSTOMER — save new reservation
//  Checks blackout dates; sends to waitlist if blacked out
// ─────────────────────────────────────────
app.post('/reserve', async (req, res) => {
  try {
    const { firstName, lastName, phone, email, date, time, guests, occasion, dietary, request } = req.body;

    // Check blackout
    const blackout = await pool.query(
      `SELECT reason FROM blackout_dates WHERE date = $1 LIMIT 1;`, [date]
    );
    if (blackout.rows.length) {
      const wl = await pool.query(
        `INSERT INTO waitlist
         (first_name, last_name, phone, email, date, time, guests, occasion, dietary, request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;`,
        [firstName, lastName, phone, email, date, time, guests, occasion, dietary, request]
      );
      console.log(`⏸ Date blacked out → waitlist #${wl.rows[0].id}`);
      return res.json({
        success: true, id: wl.rows[0].id, waitlisted: true,
        blackoutReason: blackout.rows[0].reason || 'This date is unavailable.'
      });
    }

    const result = await pool.query(
      `INSERT INTO reservations
       (first_name, last_name, phone, email, date, time, guests, occasion, dietary, request, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *;`,
      [firstName, lastName, phone, email, date, time, guests, occasion, dietary, request]
    );
    console.log("✅ Reservation saved, ID:", result.rows[0].id);
    res.json({ success: true, id: result.rows[0].id, waitlisted: false });
  } catch (err) {
    console.error("❌ Insert error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  CUSTOMER — check reservation status
// ─────────────────────────────────────────
app.get('/customer/reservations', async (req, res) => {
  try {
    const { phone, id } = req.query;
    if (!phone && !id) return res.status(400).json({ success: false, error: 'Provide phone or id' });

    let result;
    if (id) {
      result = await pool.query(
        `SELECT id, first_name, last_name, phone, date, time, guests, occasion,
                status, admin_note, created_at
         FROM reservations WHERE id = $1 LIMIT 1;`, [id]
      );
    } else {
      const normalized = phone.replace(/\D/g, '').slice(-10);
      result = await pool.query(
        `SELECT id, first_name, last_name, phone, date, time, guests, occasion,
                status, admin_note, created_at
         FROM reservations
         WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $1
         ORDER BY created_at DESC LIMIT 10;`, [normalized]
      );
    }
    res.json({ success: true, reservations: result.rows });
  } catch (err) {
    console.error("❌ Customer lookup error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  CUSTOMER — cancel
// ─────────────────────────────────────────
app.patch('/customer/reservations/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.body;
    const check = await pool.query(`SELECT * FROM reservations WHERE id = $1 LIMIT 1;`, [id]);
    if (!check.rows.length) return res.status(404).json({ success: false, error: 'Booking not found.' });
    const r = check.rows[0];
    if (r.status === 'cancelled') return res.status(400).json({ success: false, error: 'Already cancelled.' });
    if (r.status === 'rejected')  return res.status(400).json({ success: false, error: 'Already rejected.' });
    const bookingPhone = (r.phone || '').replace(/\D/g, '').slice(-10);
    const inputPhone   = (phone   || '').replace(/\D/g, '').slice(-10);
    if (bookingPhone !== inputPhone) return res.status(403).json({ success: false, error: 'Phone number does not match.' });
    await pool.query(`UPDATE reservations SET status='cancelled', admin_note='Cancelled by customer' WHERE id=$1;`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — get all reservations
// ─────────────────────────────────────────
app.get('/admin/reservations', async (req, res) => {
  try {
    const { status, date } = req.query;
    let query = `SELECT * FROM reservations WHERE 1=1`;
    const values = [];
    let idx = 1;
    if (status && status !== 'all') { query += ` AND status = $${idx++}`; values.push(status); }
    if (date)                        { query += ` AND date = $${idx++}`;   values.push(date); }
    query += ` ORDER BY created_at DESC`;
    const result = await pool.query(query, values);
    res.json({ success: true, reservations: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — stats
// ─────────────────────────────────────────
app.get('/admin/stats', async (req, res) => {
  try {
    const [stats, wl] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                           AS total,
          COUNT(*) FILTER (WHERE status = 'pending')        AS pending,
          COUNT(*) FILTER (WHERE status = 'accepted')       AS accepted,
          COUNT(*) FILTER (WHERE status = 'rejected')       AS rejected,
          COUNT(*) FILTER (WHERE date::date = CURRENT_DATE) AS today
        FROM reservations;
      `),
      pool.query(`SELECT COUNT(*) AS waiting FROM waitlist WHERE status = 'waiting';`)
    ]);
    res.json({ success: true, stats: { ...stats.rows[0], waitlist: wl.rows[0].waiting } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — accept / reject / delete
// ─────────────────────────────────────────
app.patch('/admin/reservations/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const result = await pool.query(
      `UPDATE reservations SET status='accepted', admin_note=$1 WHERE id=$2 RETURNING *;`,
      [note || '', id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    const waMsg = `Hi ${r.first_name}, your table at Cafe Fazal is CONFIRMED for ${r.date} at ${r.time} for ${r.guests}. See you soon! 🍽️`;
    res.json({ success: true, reservation: r, whatsappMessage: waMsg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/admin/reservations/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const result = await pool.query(
      `UPDATE reservations SET status='rejected', admin_note=$1 WHERE id=$2 RETURNING *;`,
      [note || '', id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const r = result.rows[0];
    const waMsg = `Hi ${r.first_name}, unfortunately we cannot accommodate your reservation on ${r.date} at ${r.time}. Please call +91 9920599891 to reschedule. Sorry!`;
    res.json({ success: true, reservation: r, whatsappMessage: waMsg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/admin/reservations/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM reservations WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — WAITLIST
// ─────────────────────────────────────────
app.get('/admin/waitlist', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM waitlist ORDER BY created_at DESC;`);
    res.json({ success: true, waitlist: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/admin/waitlist/:id/accept', async (req, res) => {
  try {
    const wl = await pool.query(`SELECT * FROM waitlist WHERE id=$1 LIMIT 1;`, [req.params.id]);
    if (!wl.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    const w = wl.rows[0];

    const ins = await pool.query(
      `INSERT INTO reservations
       (first_name, last_name, phone, email, date, time, guests, occasion, dietary, request, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id;`,
      [w.first_name, w.last_name, w.phone, w.email, w.date, w.time, w.guests, w.occasion, w.dietary, w.request]
    );
    await pool.query(`UPDATE waitlist SET status='promoted' WHERE id=$1;`, [req.params.id]);

    const newId = ins.rows[0].id;
    const waMsg = `Hi ${w.first_name}, great news! A spot opened at Cafe Fazal for ${w.date} at ${w.time}. Booking #${newId} is now under review. We'll confirm shortly! 🍽️`;
    res.json({ success: true, newReservationId: newId, whatsappMessage: waMsg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/admin/waitlist/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM waitlist WHERE id=$1;`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — BLACKOUT DATES
// ─────────────────────────────────────────
app.get('/admin/blackout', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM blackout_dates ORDER BY date ASC;`);
    res.json({ success: true, dates: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/blackout', async (req, res) => {
  try {
    const { date, reason } = req.body;
    const result = await pool.query(
      `INSERT INTO blackout_dates (date, reason) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET reason = EXCLUDED.reason RETURNING *;`,
      [date, reason || '']
    );
    res.json({ success: true, blackout: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/admin/blackout/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM blackout_dates WHERE id=$1;`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public endpoint for booking form to know which dates are unavailable
app.get('/blackout-dates', async (req, res) => {
  try {
    const result = await pool.query(`SELECT date, reason FROM blackout_dates ORDER BY date ASC;`);
    res.json({ success: true, dates: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  NEWSLETTER — subscribe (public)
// ─────────────────────────────────────────
app.post('/newsletter/subscribe', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Invalid email.' });
    }

    // Check duplicate
    const existing = await pool.query(
      `SELECT id FROM newsletter_subscribers WHERE LOWER(email) = LOWER($1) LIMIT 1;`, [email]
    );
    if (existing.rows.length) {
      return res.json({ success: false, duplicate: true });
    }

    await pool.query(
      `INSERT INTO newsletter_subscribers (name, email) VALUES ($1, $2);`,
      [name || '', email.toLowerCase().trim()]
    );
    console.log(`📧 New subscriber: ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Subscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  ADMIN — newsletter subscribers
//  GET    /admin/newsletter
//  DELETE /admin/newsletter/:id
// ─────────────────────────────────────────
app.get('/admin/newsletter', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM newsletter_subscribers WHERE active = TRUE ORDER BY subscribed_at DESC;`
    );
    res.json({ success: true, subscribers: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/admin/newsletter/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE newsletter_subscribers SET active = FALSE WHERE id = $1;`, [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
app.listen(5000, () => {
  console.log('');
  console.log('🚀  Server   →  http://localhost:5000');
  console.log('🌐  Website  →  http://localhost:5000/index.html');
  console.log('📱  Status   →  http://localhost:5000/status.html');
  console.log('📋  Admin    →  http://localhost:5000/admin.html');
  console.log('');
  console.log('🔐  Admin Password:', process.env.ADMIN_PASSWORD || 'cafefazal2024');
  console.log('   (Set ADMIN_PASSWORD env var to change it)');
  console.log('');
});
