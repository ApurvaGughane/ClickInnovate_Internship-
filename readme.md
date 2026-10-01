# Hostel Room Management Portal

Warden manages rooms and bed capacity; students browse vacancies and book one bed.
Stack: Node.js, Express, MongoDB (Mongoose), vanilla JS frontend, JWT auth.

## Setup
```bash
npm install
cp .env.example .env     # set MONGO_URI (local or Atlas) and JWT_SECRET
npm start                # http://localhost:3000
```

## Test credentials
| Role    | Email              | Password   |
|---------|--------------------|------------|
| Warden  | warden@hostel.com  | warden123  | (auto-seeded on first run)
| Student | register in the app (Register tab) |

Other wardens can register using the access code in `WARDEN_CODE` (default `WARDEN2026`).

## Features
- Role-based login/registration (Warden, Student)
- Warden: add rooms (number, floor, AC/Non-AC, capacity ≥ 1), see occupancy and resident names per room
- Student: room catalog with total/available beds and a Book Bed button; shows current room once allocated
- Rooms flip to **Full** automatically at 0 vacancies

## Business rules and how they are enforced
- Duplicate room numbers: unique index on `Room.roomNumber` (409 error)
- Required fields / capacity ≥ 1: validated in the API and the schema
- One bed per student: unique index on `Allocation.student`
- No overbooking: a single atomic `findOneAndUpdate` increments `occupied` only when `occupied < capacity`; if it fails the allocation is rolled back. Concurrent requests cannot exceed capacity.

## API
`POST /api/auth/register` · `POST /api/auth/login` · `POST /api/rooms` (warden) · `GET /api/admin/rooms` (warden) · `GET /api/rooms` · `GET /api/my-allocation` · `POST /api/rooms/:id/book` (student)

## Deploy (Render)
Create a Web Service, build `npm install`, start `npm start`; add env vars `MONGO_URI` (MongoDB Atlas), `JWT_SECRET`, `WARDEN_CODE`.