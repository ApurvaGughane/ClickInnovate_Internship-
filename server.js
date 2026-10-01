require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const { MONGO_URI = 'mongodb://127.0.0.1:27017/hostel', JWT_SECRET = 'dev-secret',
        WARDEN_CODE = 'WARDEN2026', PORT = 3000 } = process.env;

/* ---------- Models ---------- */
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['warden', 'student'], default: 'student' }
}, { timestamps: true }));

const Room = mongoose.model('Room', new mongoose.Schema({
  roomNumber: { type: String, required: true, unique: true, trim: true },
  floor: { type: Number, required: true, min: 0 },
  type: { type: String, enum: ['AC', 'Non-AC'], default: 'Non-AC' },
  capacity: { type: Number, required: true, min: 1 },
  occupied: { type: Number, default: 0, min: 0 }
}, { timestamps: true }));

// unique `student` index = one bed per student, enforced by the database
const Allocation = mongoose.model('Allocation', new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true }
}, { timestamps: true }));

/* ---------- Helpers ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: 'Server error' });
});
const sign = u => jwt.sign({ id: u._id, role: u.role }, JWT_SECRET, { expiresIn: '8h' });
const userOut = u => ({ id: u._id, name: u.name, email: u.email, role: u.role });

const auth = (...roles) => (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(t, JWT_SECRET);
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};
const roomOut = r => ({ id: r._id, roomNumber: r.roomNumber, floor: r.floor, type: r.type,
  capacity: r.capacity, occupied: r.occupied, available: r.capacity - r.occupied,
  status: r.occupied >= r.capacity ? 'Full' : 'Available' });

/* ---------- Auth ---------- */
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password, role, wardenCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role === 'warden' && wardenCode !== WARDEN_CODE) return res.status(403).json({ error: 'Invalid warden access code' });
  if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered' });
  const user = await User.create({ name, email, password: await bcrypt.hash(password, 10),
    role: role === 'warden' ? 'warden' : 'student' });
  res.status(201).json({ token: sign(user), user: userOut(user) });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const user = await User.findOne({ email: (req.body.email || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password)))
    return res.status(401).json({ error: 'Incorrect email or password' });
  res.json({ token: sign(user), user: userOut(user) });
}));

/* ---------- Warden ---------- */
app.post('/api/rooms', auth('warden'), wrap(async (req, res) => {
  const { roomNumber, floor, type, capacity } = req.body;
  const cap = Number(capacity), fl = Number(floor);
  if (!roomNumber || !String(roomNumber).trim() || floor === '' || floor == null || Number.isNaN(fl))
    return res.status(400).json({ error: 'Room number and floor are required' });
  if (!Number.isInteger(cap) || cap < 1) return res.status(400).json({ error: 'Bed capacity must be at least 1' });
  if (!['AC', 'Non-AC'].includes(type)) return res.status(400).json({ error: 'Room type must be AC or Non-AC' });
  try {
    const room = await Room.create({ roomNumber: String(roomNumber).trim(), floor: fl, type, capacity: cap });
    res.status(201).json(roomOut(room));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: `Room ${roomNumber} already exists` });
    throw e;
  }
}));

app.get('/api/admin/rooms', auth('warden'), wrap(async (req, res) => {
  const [rooms, allocs] = await Promise.all([
    Room.find().sort({ floor: 1, roomNumber: 1 }),
    Allocation.find().populate('student', 'name email')
  ]);
  res.json(rooms.map(r => ({ ...roomOut(r),
    residents: allocs.filter(a => String(a.room) === String(r._id) && a.student)
                     .map(a => ({ name: a.student.name, email: a.student.email, since: a.createdAt })) })));
}));

/* ---------- Student ---------- */
app.get('/api/rooms', auth(), wrap(async (req, res) => {
  const rooms = await Room.find().sort({ floor: 1, roomNumber: 1 });
  res.json(rooms.map(roomOut));
}));

app.get('/api/my-allocation', auth('student'), wrap(async (req, res) => {
  const a = await Allocation.findOne({ student: req.user.id }).populate('room');
  res.json(a ? { room: roomOut(a.room), since: a.createdAt } : null);
}));

app.post('/api/rooms/:id/book', auth('student'), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid room' });
  // Step 1: claim the student's single bed (unique index rejects a second booking)
  let alloc;
  try { alloc = await Allocation.create({ student: req.user.id, room: req.params.id }); }
  catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'You already have a bed in the hostel' });
    throw e;
  }
  // Step 2: atomically take a bed only if one is free (no overbooking under concurrent requests)
  const room = await Room.findOneAndUpdate(
    { _id: req.params.id, $expr: { $lt: ['$occupied', '$capacity'] } },
    { $inc: { occupied: 1 } }, { new: true });
  if (!room) {
    await Allocation.deleteOne({ _id: alloc._id }); // roll back
    const exists = await Room.exists({ _id: req.params.id });
    return res.status(exists ? 409 : 404).json({ error: exists ? 'This room is full' : 'Room not found' });
  }
  res.status(201).json({ room: roomOut(room) });
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

mongoose.connect(MONGO_URI).then(async () => {
  await Promise.all([User.init(), Room.init(), Allocation.init()]); // ensure unique indexes exist
  if (!(await User.findOne({ role: 'warden' }))) {
    await User.create({ name: 'Chief Warden', email: 'warden@hostel.com', role: 'warden',
      password: await bcrypt.hash('warden123', 10) });
    console.log('Seeded warden: warden@hostel.com / warden123');
  }
  app.listen(PORT, () => console.log(`Hostel portal on http://localhost:${PORT}`));
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });