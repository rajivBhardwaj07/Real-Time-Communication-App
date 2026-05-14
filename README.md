# Real-Time Communication App

A browser-based video conferencing and collaboration tool built with **WebRTC**, **Socket.io**, and **Node.js**. Multi-user video calls, screen sharing, file transfer, a shared whiteboard, and end-to-end encrypted chat — all in a single self-contained app.

![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Express%20%7C%20Socket.io%20%7C%20WebRTC-7c5cff)

---

## Features

| Feature | How it works |
|---|---|
| **Multi-user video calls** | WebRTC mesh topology — every peer connects directly to every other peer. Good for 2–4 users. |
| **Screen sharing** | `getDisplayMedia()` + `RTCRtpSender.replaceTrack()` swaps the outgoing video track on the fly. |
| **File sharing** | Primary path: WebRTC **DataChannel** with chunking + backpressure. Fallback: Socket.io relay if the data channel isn't open. |
| **Whiteboard** | HTML `<canvas>`; strokes broadcast over Socket.io. Server keeps recent history so latecomers see existing strokes. |
| **End-to-end encrypted chat** | AES-GCM via Web Crypto. Key is derived from a room passphrase using PBKDF2 (100k iterations, SHA-256). The server only ever sees ciphertext. |
| **User authentication** | Username + password, hashed with **bcrypt**. Sessions issued as **JWT** (12h expiry). Socket.io handshake is gated on the JWT. |

---

## Prerequisites

- **Node.js 18+** (tested on v24)
- A modern Chromium- or Firefox-based browser

---

## Setup & running

```bash
# 1. install dependencies
npm install

# 2. start the server
npm start
```

The server listens on **http://localhost:3000**. Open that URL in your browser.

To test multi-user features, open the app in **two different browser windows** (or two different browsers, or a browser + an incognito window). Register two separate users, then join the **same room name** with the **same passphrase** in both.

> **Note on HTTPS:** Browsers only grant camera/mic/screen access on `localhost` *or* HTTPS. The app works as-is on your own machine. To test from another device on your LAN you'll need to terminate TLS — easiest path is [`mkcert`](https://github.com/FiloSottile/mkcert) for a locally-trusted cert, then swap `http.createServer` for `https.createServer` in [server.js](server.js).

---

## Usage

1. **Register** an account (username ≥ 3 chars, password ≥ 6 chars).
2. **Join a room** — type any room name and a shared passphrase. The passphrase is used to derive the chat encryption key, so all participants must use the same one.
3. **Allow camera and microphone** when prompted.
4. Use the top-bar controls:
   - **Mic** / **Cam** — toggle local audio/video tracks
   - **Share Screen** — start/stop screen capture (replaces your video track)
   - **Whiteboard** — open the collaborative drawing overlay
   - **Leave** — reload the page
5. Send chat messages and files from the right-hand side panel.

---

## Project structure

```
.
├── server.js              # Express + Socket.io: auth, JWT, signaling, room state
├── package.json
├── users.json             # auto-created; bcrypt-hashed credentials (demo storage)
└── public/
    ├── index.html         # auth screen, lobby, main app shell
    ├── style.css          # styling (dark, glass-morphism)
    └── app.js             # client logic: auth, WebRTC, chat, files, whiteboard
```

### Key code locations

- **Auth endpoints** — [server.js](server.js) (`/api/register`, `/api/login`)
- **Socket.io JWT middleware + signaling relay** — [server.js](server.js)
- **WebRTC peer setup** — [public/app.js](public/app.js) (`ensurePeer`)
- **Screen-share track swap** — [public/app.js](public/app.js) (`replaceVideoTrack`)
- **AES-GCM chat encryption** — [public/app.js](public/app.js) (`deriveKey`, `encryptText`, `decryptText`)
- **File transfer over DataChannel** — [public/app.js](public/app.js) (`sendFileBtn.onclick`, `receiveFileMessage`)
- **Whiteboard** — [public/app.js](public/app.js) (`drawStroke`, stroke socket events)

---

## Architecture overview

```
   Browser A                   Server                   Browser B
   ┌────────┐         ┌───────────────────┐         ┌────────┐
   │  app   │◀── HTTP /api/login ────────▶│  Express │
   │   +    │                              │  JWT    │
   │  WebRTC│◀── WSS Socket.io ────────────▶ Socket  │
   │   +    │   (signaling, chat ct,      │  .io    │
   │ Canvas │    whiteboard, file relay)  │ rooms   │
   └────────┘                              └─────────┘
        ▲                                              ▲
        └────────── WebRTC P2P ────────────────────────┘
                    (media + DataChannel for files)
```

- **Signaling only** flows through the server. Once peers complete the ICE handshake, **media and file bytes travel directly peer-to-peer** over WebRTC.
- **Chat ciphertext** is relayed by the server but cannot be decrypted without the room passphrase.
- The server is **stateless** beyond per-room whiteboard history and the user file.

---

## Security notes

- Passwords are **bcrypt** hashed (cost 10) before storage.
- JWTs are signed with a secret read from `JWT_SECRET` env var, or a random per-process secret if unset (logins won't survive a restart in dev).
- Chat is **end-to-end encrypted** (AES-256-GCM, PBKDF2-derived key). The server cannot read messages.
- WebRTC itself encrypts all media (DTLS-SRTP) and DataChannel traffic by default.
- **Demo caveats:** the included user store is a JSON file (`users.json`) — not suitable for production. There is no rate-limiting, no email verification, no password reset, and no CSRF protection on the auth endpoints. Treat this as a learning project, not a deployable service.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | random per-process | Signing key for session tokens. Set this in any non-trivial deployment. |

---

## Caveats & where you'd go next

- **Mesh scaling:** every peer sends its stream to every other peer, so bandwidth grows as O(N²). Beyond ~4 users, swap in an SFU like [mediasoup](https://mediasoup.org/) or [LiveKit](https://livekit.io/).
- **TURN:** only public STUN servers are configured. Peers behind symmetric NATs may fail to connect — add a TURN server (e.g. [coturn](https://github.com/coturn/coturn)) for production.
- **Persistence:** users live in a JSON file. Swap for Postgres / SQLite / Redis as needed.
- **No recording, no presence, no waiting room, no roles** — all reasonable next steps.

---

## License

MIT — use, modify, and ship freely.
