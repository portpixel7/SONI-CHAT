# SONI temporary chat

Real-time, account-free temporary rooms built with Express and Socket.IO.

## Local development

Requires Node.js 20 or newer.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Run the self-contained integration checks with `npm test`.

## Production configuration

- `PORT`: HTTP port (the hosting platform normally sets this).
- `NODE_ENV=production`: enables HSTS.
- `ADMIN_TOKEN`: required Bearer token for the moderation endpoints.
- `ALLOWED_ORIGINS`: optional comma-separated list of permitted browser origins. When omitted, only the request host is accepted.
- `MAX_ROOM_MEMBERS`: maximum concurrent members per room; defaults to 50.

Images up to 5 MB can be sent in PNG, JPEG, WebP, or GIF format.

Read reports with `GET /api/reports` and clear reviewed reports with `DELETE /api/reports`, using `Authorization: Bearer <ADMIN_TOKEN>`.

All application state is kept in memory and is lost on restart. Deploy one server instance only. Horizontal scaling requires a shared Socket.IO adapter and shared state store.
