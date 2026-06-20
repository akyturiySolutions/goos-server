# GO OS Server — Setup Guide

## 1. Install dependencies
```bash
cd server
npm install
```

## 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your real values
```

### Africa's Talking (SMS)
1. Sign up at africastalking.com
2. Go to Settings → API Keys
3. Copy your API Key and Username
4. For Kenya sandbox testing, username = "sandbox"

### Gmail SMTP (Email)
1. Enable 2-Factor Auth on your Gmail account
2. Go to Google Account → Security → App Passwords
3. Generate a password for "Mail"
4. Use that 16-character password as SMTP_PASS

### Firebase Admin SDK
1. Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Copy projectId, clientEmail, and privateKey into .env

### Flutterwave Webhook
1. Flutterwave Dashboard → Settings → Webhooks
2. Set URL to: https://your-server.com/webhook/flutterwave
3. Set Secret Hash — copy same value to FLW_SECRET_HASH in .env

## 3. Run the server
```bash
# Development
npm run dev

# Production
npm start
```

## 4. Deploy (recommended: Railway or Render)
- Railway: railway.app — connect GitHub repo, set env vars, deploy
- Render: render.com — free tier available, set env vars

## Notification Schedule
Runs automatically every day at 08:00 AM EAT (Nairobi time).
Notifies clients with subscriptions expiring in exactly 7, 3, or 1 day(s).
Each notification is only sent once per subscription per trigger day.

## Manual trigger
POST /api/notifications/run
Header: x-admin-secret: YOUR_ADMIN_SECRET
(Use the "Send Reminders Now" button in the dashboard)
