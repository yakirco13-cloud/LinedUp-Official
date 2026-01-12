/**
 * LinedUp WhatsApp Service v2.1 (SECURED)
 * 
 * Security Features:
 * - API Key validation
 * - Rate limiting per IP
 * - CORS restricted to your domain
 * - Request logging
 * 
 * Features:
 * - OTP Authentication (send & verify)
 * - Booking confirmations
 * - Booking updates/cancellations
 * - Automated reminders
 * - Waiting list notifications
 * - Broadcast messages
 * 
 * Connects to: Supabase (not Base44)
 * Provider: Twilio WhatsApp API
 */

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { he } from 'date-fns/locale';

// Set timezone to Israel
process.env.TZ = 'Asia/Jerusalem';

// Initialize Express
const app = express();

// ============================================================
// SECURITY CONFIGURATION
// ============================================================

// API Key for authentication (set this in Railway environment variables)
const API_KEY = process.env.API_KEY || 'your-secret-api-key-change-this';

// Allowed origins (your frontend domains)
const ALLOWED_ORIGINS = [
  'https://linedup.co.il',
  'https://www.linedup.co.il',
  'https://linedup-app.netlify.app',
  'http://localhost:5173',  // Local dev
  'http://localhost:3000',  // Local dev
  process.env.FRONTEND_URL  // Custom frontend URL from env
].filter(Boolean);

// CORS configuration - restrict to your domains only
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl for testing)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked request from: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// ============================================================
// RATE LIMITING (In-Memory)
// ============================================================

const rateLimitStore = new Map();

// Rate limit configuration per endpoint type
const RATE_LIMITS = {
  otp: { windowMs: 60 * 1000, maxRequests: 3 },      // 3 OTP requests per minute per IP
  message: { windowMs: 60 * 1000, maxRequests: 30 }, // 30 messages per minute per IP
  broadcast: { windowMs: 60 * 1000, maxRequests: 2 } // 2 broadcasts per minute per IP
};

/**
 * Clean up old rate limit entries
 */
function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.windowStart + data.windowMs) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean up every minute
setInterval(cleanupRateLimits, 60 * 1000);

/**
 * Rate limit middleware factory
 */
function rateLimit(type) {
  const config = RATE_LIMITS[type] || RATE_LIMITS.message;
  
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `${type}:${ip}`;
    const now = Date.now();
    
    let entry = rateLimitStore.get(key);
    
    if (!entry || now > entry.windowStart + config.windowMs) {
      // New window
      entry = { windowStart: now, windowMs: config.windowMs, count: 0 };
      rateLimitStore.set(key, entry);
    }
    
    entry.count++;
    
    if (entry.count > config.maxRequests) {
      console.warn(`⚠️ Rate limit exceeded for ${ip} on ${type}`);
      return res.status(429).json({ 
        error: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((entry.windowStart + config.windowMs - now) / 1000)
      });
    }
    
    next();
  };
}

// ============================================================
// API KEY VALIDATION MIDDLEWARE
// ============================================================

/**
 * Validate API key from header or query param
 * Header: X-API-Key: your-key
 * Or Query: ?apiKey=your-key
 */
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  // Skip API key check for health endpoint
  if (req.path === '/health') {
    return next();
  }
  
  if (!apiKey || apiKey !== API_KEY) {
    console.warn(`⚠️ Invalid API key attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  
  next();
}

// Apply API key validation to all routes
app.use(validateApiKey);

// ============================================================
// REQUEST LOGGING MIDDLEWARE
// ============================================================

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`📥 ${timestamp} | ${req.method} ${req.path} | IP: ${req.ip}`);
  next();
});

// ============================================================
// CONFIGURATION
// ============================================================

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ ERROR: Missing Supabase credentials!');
  console.error('Please set: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Twilio Configuration - ALL templates from environment variables
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  // Template SIDs - all from environment variables
  otpTemplateSid: process.env.TWILIO_OTP_TEMPLATE_SID,
  confirmationTemplateSid: process.env.TWILIO_CONFIRMATION_TEMPLATE_SID,
  updateTemplateSid: process.env.TWILIO_UPDATE_TEMPLATE_SID,
  cancelTemplateSid: process.env.TWILIO_CANCEL_TEMPLATE_SID,
  waitingListTemplateSid: process.env.TWILIO_WAITING_LIST_TEMPLATE_SID,
  reminderTemplateSid: process.env.TWILIO_REMINDER_TEMPLATE_SID,
  broadcastTemplateSid: process.env.TWILIO_BROADCAST_TEMPLATE_SID,
};

// Validate required Twilio credentials
if (!TWILIO_CONFIG.accountSid || !TWILIO_CONFIG.authToken || !TWILIO_CONFIG.whatsappNumber) {
  console.error('❌ ERROR: Missing Twilio credentials!');
  console.error('Please set: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER');
  process.exit(1);
}

// Validate required template SIDs
const requiredTemplates = ['otpTemplateSid', 'confirmationTemplateSid', 'updateTemplateSid', 'cancelTemplateSid', 'waitingListTemplateSid'];
const missingTemplates = requiredTemplates.filter(t => !TWILIO_CONFIG[t]);
if (missingTemplates.length > 0) {
  console.error('❌ ERROR: Missing Twilio template SIDs!');
  console.error('Please set:', missingTemplates.map(t => `TWILIO_${t.replace('TemplateSid', '').toUpperCase()}_TEMPLATE_SID`).join(', '));
  process.exit(1);
}

// ============================================================
// OTP STORAGE (In-Memory with expiration)
// ============================================================

const otpStore = new Map();
const OTP_EXPIRY_MINUTES = 10;

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Store OTP with expiration
 */
function storeOTP(phone, otp) {
  const normalizedPhone = normalizePhoneNumber(phone);
  otpStore.set(normalizedPhone, {
    code: otp,
    expiresAt: Date.now() + (OTP_EXPIRY_MINUTES * 60 * 1000),
    attempts: 0
  });
  
  // Auto-cleanup after expiry
  setTimeout(() => {
    otpStore.delete(normalizedPhone);
  }, OTP_EXPIRY_MINUTES * 60 * 1000);
}

/**
 * Verify OTP
 */
function verifyOTP(phone, code) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const stored = otpStore.get(normalizedPhone);
  
  if (!stored) {
    return { valid: false, error: 'OTP not found or expired' };
  }
  
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(normalizedPhone);
    return { valid: false, error: 'OTP expired' };
  }
  
  // Rate limiting - max 5 attempts
  if (stored.attempts >= 5) {
    otpStore.delete(normalizedPhone);
    return { valid: false, error: 'Too many attempts' };
  }
  
  stored.attempts++;
  
  if (stored.code !== code) {
    return { valid: false, error: 'Invalid OTP' };
  }
  
  // Success - remove OTP
  otpStore.delete(normalizedPhone);
  return { valid: true };
}

// ============================================================
// PHONE NUMBER UTILITIES
// ============================================================

/**
 * Normalize phone number (remove formatting, ensure consistent format)
 */
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // If starts with 0, remove it (Israeli numbers)
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  
  // If doesn't start with country code, add Israel code (972)
  if (!cleaned.startsWith('972')) {
    cleaned = '972' + cleaned;
  }
  
  return cleaned;
}

/**
 * Format phone number for WhatsApp
 */
function formatPhoneForWhatsApp(phone) {
  const normalized = normalizePhoneNumber(phone);
  return normalized ? `whatsapp:+${normalized}` : null;
}

// ============================================================
// TWILIO API HELPERS
// ============================================================

/**
 * Send WhatsApp message via Twilio
 */
async function sendWhatsAppMessage(to, templateSid, variables) {
  const formattedNumber = formatPhoneForWhatsApp(to);
  if (!formattedNumber) {
    throw new Error('Invalid phone number');
  }
  
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');
  
  const params = new URLSearchParams();
  params.append('To', formattedNumber);
  params.append('From', TWILIO_CONFIG.whatsappNumber);
  params.append('ContentSid', templateSid);
  params.append('ContentVariables', JSON.stringify(variables));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    console.error('❌ Twilio error:', result);
    throw new Error(result.message || 'Failed to send WhatsApp message');
  }
  
  return result;
}

/**
 * Send OTP via WhatsApp (Authentication template)
 */
async function sendOTPWhatsApp(to, otp) {
  const formattedNumber = formatPhoneForWhatsApp(to);
  if (!formattedNumber) {
    throw new Error('Invalid phone number');
  }
  
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_CONFIG.accountSid}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_CONFIG.accountSid}:${TWILIO_CONFIG.authToken}`).toString('base64');
  
  // Authentication template uses special format
  const params = new URLSearchParams();
  params.append('To', formattedNumber);
  params.append('From', TWILIO_CONFIG.whatsappNumber);
  params.append('ContentSid', TWILIO_CONFIG.otpTemplateSid);
  params.append('ContentVariables', JSON.stringify({ "1": otp }));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    console.error('❌ Twilio OTP error:', result);
    throw new Error(result.message || 'Failed to send OTP');
  }
  
  return result;
}

// ============================================================
// API ENDPOINTS
// ============================================================

// Health check (no API key required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.1.0-secured',
    timestamp: new Date().toISOString(),
    supabase: !!SUPABASE_URL,
    twilio: !!TWILIO_CONFIG.accountSid
  });
});

// ============================================================
// OTP ENDPOINTS (with rate limiting)
// ============================================================

/**
 * Send OTP
 * POST /api/otp/send
 * Body: { phone: "0541234567" }
 */
app.post('/api/otp/send', rateLimit('otp'), async (req, res) => {
  console.log('📥 OTP send request:', req.body);
  
  const { phone } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  try {
    // Generate OTP
    const otp = generateOTP();
    
    // Store OTP
    storeOTP(phone, otp);
    
    // Send via WhatsApp
    await sendOTPWhatsApp(phone, otp);
    
    console.log(`✅ OTP sent to ${phone.substring(0, 4)}****`);
    res.json({ success: true, message: 'OTP sent via WhatsApp' });
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Verify OTP
 * POST /api/otp/verify
 * Body: { phone: "0541234567", code: "123456" }
 */
app.post('/api/otp/verify', rateLimit('otp'), async (req, res) => {
  console.log('📥 OTP verify request');
  
  const { phone, code } = req.body;
  
  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and code are required' });
  }
  
  const result = verifyOTP(phone, code);
  
  if (result.valid) {
    console.log(`✅ OTP verified for ${phone.substring(0, 4)}****`);
    res.json({ success: true, verified: true });
  } else {
    console.log(`❌ OTP verification failed: ${result.error}`);
    res.status(400).json({ success: false, error: result.error });
  }
});

// ============================================================
// NOTIFICATION ENDPOINTS (with rate limiting)
// ============================================================

/**
 * Send booking confirmation
 * POST /api/send-confirmation
 */
app.post('/api/send-confirmation', rateLimit('message'), async (req, res) => {
  console.log('📥 Confirmation request');
  
  const { phone, clientName, businessName, date, time } = req.body;
  
  if (!phone || !clientName || !businessName || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    let formattedDate;
    try {
      formattedDate = format(parseISO(date), 'd.M.yyyy');
    } catch (e) {
      formattedDate = date;
    }
    // Format time as HH:MM (remove seconds if present)
    const formattedTime = time.substring(0, 5);
    
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.confirmationTemplateSid,
      {
        "1": String(clientName),
        "2": String(businessName),
        "3": String(formattedDate),
        "4": String(formattedTime)
      }
    );
    
    console.log('✅ Confirmation sent');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending confirmation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send booking update/cancellation
 * POST /api/send-update
 */
app.post('/api/send-update', rateLimit('message'), async (req, res) => {
  console.log('📥 Update request');
  
  const { phone, clientName, businessName } = req.body;
  
  if (!phone || !clientName || !businessName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.updateTemplateSid,
      {
        "1": String(clientName),
        "2": String(businessName)
      }
    );
    
    console.log('✅ Update sent');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending update:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send booking cancellation
 * POST /api/send-cancellation
 * Template: היי {{1}}, התור שלך עבור {{2}} בתאריך {{3}} בוטל.
 */
app.post('/api/send-cancellation', rateLimit('message'), async (req, res) => {
  console.log('📥 Cancellation request');
  
  const { phone, clientName, serviceName, date } = req.body;
  
  if (!phone || !clientName || !serviceName || !date) {
    return res.status(400).json({ error: 'Missing required fields: phone, clientName, serviceName, date' });
  }
  
  try {
    let formattedDate;
    try {
      formattedDate = format(parseISO(date), 'd.M.yyyy');
    } catch (e) {
      formattedDate = date;
    }
    
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.cancelTemplateSid,
      {
        "1": String(clientName),
        "2": String(serviceName),
        "3": String(formattedDate)
      }
    );
    
    console.log('✅ Cancellation sent');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending cancellation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send waiting list notification
 * POST /api/send-waiting-list
 */
app.post('/api/send-waiting-list', rateLimit('message'), async (req, res) => {
  console.log('📥 Waiting list notification request:', req.body);
  
  const { phone, clientName, date, serviceName } = req.body;
  
  if (!phone || !clientName || !date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    let formattedDate;
    try {
      formattedDate = format(parseISO(date), 'd.M.yyyy');
    } catch (e) {
      formattedDate = date;
    }
    
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.waitingListTemplateSid,
      {
        "1": String(clientName),
        "2": String(formattedDate),
        "3": String(serviceName || 'תור')
      }
    );
    
    console.log('✅ Waiting list notification sent');
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('❌ Error sending waiting list notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send broadcast message
 * POST /api/send-broadcast
 */
app.post('/api/send-broadcast', rateLimit('broadcast'), async (req, res) => {
  console.log('📥 Broadcast request');
  
  const { recipients, message } = req.body;
  
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid recipients' });
  }
  
  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }
  
  // Limit broadcast size to prevent abuse
  if (recipients.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 recipients per broadcast' });
  }
  
  try {
    let successCount = 0;
    let failCount = 0;
    
    for (const recipient of recipients) {
      try {
        await sendWhatsAppMessage(
          recipient.phone,
          TWILIO_CONFIG.broadcastTemplateSid,
          {
            "1": String(recipient.name || 'לקוח יקר'),
            "2": String(message)
          }
        );
        successCount++;
      } catch (e) {
        failCount++;
      }
    }
    
    console.log(`✅ Broadcast complete: ${successCount} sent, ${failCount} failed`);
    res.json({ success: true, sent: successCount, failed: failCount });
  } catch (error) {
    console.error('❌ Error sending broadcast:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// AUTOMATED REMINDERS (from Supabase)
// ============================================================

// Track sent reminders to avoid duplicates
const sentReminders = new Set();

/**
 * Fetch businesses from Supabase
 */
async function fetchBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select('*');
  
  if (error) {
    console.error('Error fetching businesses:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Fetch upcoming bookings for a business
 */
async function fetchBookings(businessId) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const in48HoursStr = in48Hours.toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'confirmed')
    .gte('date', todayStr)
    .lte('date', in48HoursStr)
    .not('client_phone', 'is', null);
  
  if (error) {
    console.error('Error fetching bookings:', error);
    return [];
  }
  
  return data || [];
}

/**
 * Process reminders for a business
 */
async function processBusinessReminders(business) {
  const reminderHours = business.reminder_hours_before || 12;
  
  console.log(`\n📋 Processing reminders for: ${business.name} (${reminderHours}h before)`);
  
  const bookings = await fetchBookings(business.id);
  
  if (bookings.length === 0) {
    console.log('   No upcoming bookings');
    return { business: business.name, sent: 0 };
  }
  
  console.log(`   Found ${bookings.length} upcoming booking(s)`);
  
  let sentCount = 0;
  const now = new Date();
  
  for (const booking of bookings) {
    const bookingDateTime = new Date(`${booking.date}T${booking.time}+02:00`);
    const minutesUntil = differenceInMinutes(bookingDateTime, now);
    
    // Send if within ±10 minutes of target reminder time
    const targetMinutes = reminderHours * 60;
    const shouldSend = minutesUntil >= (targetMinutes - 10) && minutesUntil <= (targetMinutes + 10);
    
    if (!shouldSend) continue;
    
    // Check if already sent
    const reminderKey = `${booking.id}-${booking.date}-${booking.time}`;
    if (sentReminders.has(reminderKey)) continue;
    
    console.log(`   📤 Sending to ${booking.client_name}`);
    
    try {
      const formattedDate = format(parseISO(booking.date), 'd בMMMM', { locale: he });
      // Format time as HH:MM (remove seconds if present)
      const formattedTime = booking.time.substring(0, 5);
      
      await sendWhatsAppMessage(
        booking.client_phone,
        TWILIO_CONFIG.reminderTemplateSid,
        {
          "1": booking.client_name || 'לקוח יקר',
          "2": business.name,
          "3": formattedDate,
          "4": formattedTime
        }
      );
      
      sentReminders.add(reminderKey);
      sentCount++;
    } catch (error) {
      console.error(`   ❌ Failed to send to ${booking.client_name}:`, error.message);
    }
  }
  
  return { business: business.name, sent: sentCount };
}

/**
 * Check and send reminders for all businesses
 */
async function checkAndSendReminders() {
  console.log('\n' + '='.repeat(60));
  console.log(`🔔 Reminder Check: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
  
  try {
    const businesses = await fetchBusinesses();
    console.log(`Found ${businesses.length} business(es)`);
    
    let totalSent = 0;
    
    for (const business of businesses) {
      const result = await processBusinessReminders(business);
      totalSent += result.sent;
    }
    
    console.log(`\n📊 Total reminders sent: ${totalSent}`);
    console.log('='.repeat(60) + '\n');
  } catch (error) {
    console.error('❌ Error in reminder check:', error);
  }
}

/**
 * Schedule reminder checks at :00, :15, :30, :45
 */
function scheduleReminders() {
  // Run immediately on start
  checkAndSendReminders();
  
  // Calculate time until next 15-minute mark
  const now = new Date();
  const minutes = now.getMinutes();
  const nextSlot = Math.ceil((minutes + 1) / 15) * 15;
  const msUntilNext = ((nextSlot - minutes) * 60 * 1000) - (now.getSeconds() * 1000);
  
  setTimeout(() => {
    checkAndSendReminders();
    // Then run every 15 minutes
    setInterval(checkAndSendReminders, 15 * 60 * 1000);
  }, msUntilNext);
  
  console.log(`⏰ Next reminder check in ${Math.round(msUntilNext / 1000 / 60)} minutes`);
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('\n🚀 LinedUp WhatsApp Service v2.2 (SECURED) Started');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔐 API Key: ${API_KEY ? '✅ Configured' : '❌ NOT SET'}`);
  console.log(`📡 Supabase: ${SUPABASE_URL}`);
  console.log(`📱 Twilio WhatsApp: ${TWILIO_CONFIG.whatsappNumber}`);
  console.log(`\n📋 Templates loaded:`);
  console.log(`   - OTP: ${TWILIO_CONFIG.otpTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Confirmation: ${TWILIO_CONFIG.confirmationTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Update: ${TWILIO_CONFIG.updateTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Cancel: ${TWILIO_CONFIG.cancelTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Waiting List: ${TWILIO_CONFIG.waitingListTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Reminder: ${TWILIO_CONFIG.reminderTemplateSid ? '✅' : '❌'}`);
  console.log(`   - Broadcast: ${TWILIO_CONFIG.broadcastTemplateSid ? '✅' : '❌'}`);
  console.log(`\n🔒 Allowed Origins:`);
  ALLOWED_ORIGINS.forEach(origin => console.log(`   - ${origin}`));
  console.log('\n📡 Endpoints:');
  console.log('   GET  /health (no auth)');
  console.log('   POST /api/otp/send (rate limited: 3/min)');
  console.log('   POST /api/otp/verify (rate limited: 3/min)');
  console.log('   POST /api/send-confirmation (rate limited: 30/min)');
  console.log('   POST /api/send-update (rate limited: 30/min)');
  console.log('   POST /api/send-cancellation (rate limited: 30/min)');
  console.log('   POST /api/send-waiting-list (rate limited: 30/min)');
  console.log('   POST /api/send-broadcast (rate limited: 2/min, max 100 recipients)');
  console.log('');
  
  // Start reminder scheduler
  scheduleReminders();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Service shutting down...');
  process.exit(0);
});
