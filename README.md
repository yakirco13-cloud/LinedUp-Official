# LinedUp WhatsApp Service v2.0

WhatsApp OTP & Notification Service for LinedUp (Supabase version)

## Features

- ✅ OTP Authentication (send & verify via WhatsApp)
- ✅ Booking confirmations
- ✅ Booking updates/cancellations  
- ✅ Automated reminders (every 15 minutes)
- ✅ Waiting list notifications
- ✅ Broadcast messages
- ✅ Connects to Supabase

## Environment Variables

Set these in Railway:

```env
# Supabase (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Twilio (REQUIRED)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_WHATSAPP_NUMBER=whatsapp:+15558717047

# Twilio Templates
TWILIO_TEMPLATE_SID=HXxxxxx           # Reminder template
TWILIO_OTP_TEMPLATE_SID=HX4f5f36cf2e136b35474c99890e2fc612  # OTP template

# Server
PORT=3000
```

## API Endpoints

### Health Check
```
GET /health
```

### OTP Authentication

**Send OTP:**
```
POST /api/otp/send
Content-Type: application/json

{
  "phone": "0541234567"
}
```

**Verify OTP:**
```
POST /api/otp/verify
Content-Type: application/json

{
  "phone": "0541234567",
  "code": "123456"
}
```

### Notifications

**Booking Confirmation:**
```
POST /api/send-confirmation
Content-Type: application/json

{
  "phone": "0541234567",
  "clientName": "ישראל ישראלי",
  "businessName": "מספרת דוד",
  "date": "2025-01-15",
  "time": "10:00"
}
```

**Booking Update:**
```
POST /api/send-update
Content-Type: application/json

{
  "phone": "0541234567",
  "clientName": "ישראל ישראלי",
  "businessName": "מספרת דוד"
}
```

**Waiting List:**
```
POST /api/send-waiting-list
Content-Type: application/json

{
  "phone": "0541234567",
  "clientName": "ישראל ישראלי",
  "date": "2025-01-15",
  "serviceName": "תספורת"
}
```

**Broadcast:**
```
POST /api/send-broadcast
Content-Type: application/json

{
  "recipients": [
    { "phone": "0541234567", "name": "ישראל" },
    { "phone": "0549876543", "name": "דוד" }
  ],
  "message": "הודעה לכל הלקוחות"
}
```

## Deployment on Railway

1. Create new project on Railway
2. Connect your GitHub repo (or deploy from this folder)
3. Add environment variables
4. Deploy!

## Local Development

```bash
npm install
npm run dev
```
