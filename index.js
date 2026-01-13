/**
 * LinedUp WhatsApp Service v2.1
 * 
 * Features:
 * - OTP Authentication (send & verify)
 * - Booking confirmations
 * - Booking updates/cancellations
 * - Automated reminders
 * - Waiting list notifications
 * - Broadcast messages
 * - ICS Calendar Feed (NEW!)
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
app.use(cors());
app.use(express.json());

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

// Twilio Configuration
const TWILIO_CONFIG = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  templateSid: process.env.TWILIO_TEMPLATE_SID, // For reminders
  otpTemplateSid: process.env.TWILIO_OTP_TEMPLATE_SID || 'HX4f5f36cf2e136b35474c99890e2fc612',
  confirmationTemplateSid: process.env.TWILIO_CONFIRMATION_TEMPLATE_SID || 'HX833cc8141398f0a037c21e061404bba0',
  updateTemplateSid: process.env.TWILIO_UPDATE_TEMPLATE_SID || 'HXfb6f60eb9acb068d3100d204e8d866b9',
  waitingListTemplateSid: process.env.TWILIO_WAITING_LIST_TEMPLATE_SID || 'HXd75dea9bfaea32988c7532ecc6969b34',
  broadcastTemplateSid: process.env.TWILIO_BROADCAST_TEMPLATE_SID || 'HXd94763214416ec4100848e81162aad92',
};

if (!TWILIO_CONFIG.accountSid || !TWILIO_CONFIG.authToken || !TWILIO_CONFIG.whatsappNumber) {
  console.error('❌ ERROR: Missing Twilio credentials!');
  console.error('Please set: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    supabase: !!SUPABASE_URL,
    twilio: !!TWILIO_CONFIG.accountSid
  });
});

// ============================================================
// OTP ENDPOINTS
// ============================================================

/**
 * Send OTP
 * POST /api/otp/send
 * Body: { phone: "0541234567" }
 */
app.post('/api/otp/send', async (req, res) => {
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
    
    console.log('✅ OTP sent successfully');
    res.json({ success: true, message: 'OTP sent' });
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
app.post('/api/otp/verify', async (req, res) => {
  console.log('📥 OTP verify request:', req.body);
  
  const { phone, code } = req.body;
  
  if (!phone || !code) {
    return res.status(400).json({ error: 'Phone and code are required' });
  }
  
  const result = verifyOTP(phone, code);
  
  if (result.valid) {
    console.log('✅ OTP verified successfully');
    res.json({ success: true, verified: true });
  } else {
    console.log('❌ OTP verification failed:', result.error);
    res.status(400).json({ success: false, error: result.error });
  }
});

// ============================================================
// BOOKING NOTIFICATION ENDPOINTS
// ============================================================

/**
 * Send booking confirmation
 * POST /api/send-confirmation
 */
app.post('/api/send-confirmation', async (req, res) => {
  console.log('📥 Confirmation request:', req.body);
  
  const { phone, clientName, businessName, date, time, serviceName } = req.body;
  
  if (!phone || !clientName || !businessName || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    // Format the date nicely
    let formattedDate;
    try {
      formattedDate = format(parseISO(date), 'd.M.yyyy');
    } catch (e) {
      formattedDate = date;
    }
    
    // Format time as HH:MM
    const formattedTime = time.substring(0, 5);
    
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.confirmationTemplateSid,
      {
        "1": String(clientName),
        "2": String(businessName),
        "3": String(formattedDate),
        "4": String(formattedTime),
        "5": String(serviceName || 'תור')
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
app.post('/api/send-update', async (req, res) => {
  console.log('📥 Update request:', req.body);
  
  const { phone, clientName, businessName, date, time, status, serviceName } = req.body;
  
  if (!phone || !clientName || !businessName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    let formattedDate = '';
    let formattedTime = '';
    
    if (date) {
      try {
        formattedDate = format(parseISO(date), 'd.M.yyyy');
      } catch (e) {
        formattedDate = date;
      }
    }
    
    if (time) {
      formattedTime = time.substring(0, 5);
    }
    
    // Status text
    const statusText = status === 'cancelled' ? 'בוטל' : 'עודכן';
    
    const result = await sendWhatsAppMessage(
      phone,
      TWILIO_CONFIG.updateTemplateSid,
      {
        "1": String(clientName),
        "2": String(businessName),
        "3": String(statusText),
        "4": String(formattedDate || ''),
        "5": String(formattedTime || '')
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
 * Send waiting list notification
 * POST /api/send-waiting-list
 */
app.post('/api/send-waiting-list', async (req, res) => {
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
app.post('/api/send-broadcast', async (req, res) => {
  console.log('📥 Broadcast request');
  
  const { recipients, message } = req.body;
  
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid recipients' });
  }
  
  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
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
// ICS CALENDAR FEED
// ============================================================

/**
 * Generate ICS calendar feed for a business
 * GET /cal/:businessId.ics
 * 
 * Usage: Add to Google Calendar via "Add calendar from URL"
 */
app.get('/cal/:businessId.ics', async (req, res) => {
  try {
    const businessId = req.params.businessId.replace('.ics', '');
    
    console.log(`📅 Calendar feed requested for business: ${businessId}`);
    
    // Get business info
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('name, phone')
      .eq('id', businessId)
      .single();
    
    if (businessError || !business) {
      console.error('❌ Business not found:', businessId);
      return res.status(404).send('Calendar not found');
    }
    
    // Get all future bookings for this business
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: bookings, error: bookingsError } = await supabase
      .from('bookings')
      .select(`
        id,
        date,
        time,
        duration,
        status,
        client_name,
        client_phone,
        notes,
        service_id,
        services (name)
      `)
      .eq('business_id', businessId)
      .gte('date', today.toISOString().split('T')[0])
      .in('status', ['approved', 'pending', 'confirmed'])
      .order('date', { ascending: true })
      .order('time', { ascending: true });
    
    if (bookingsError) {
      console.error('❌ Error fetching bookings:', bookingsError);
      return res.status(500).send('Error generating calendar');
    }
    
    // Generate ICS content
    const icsContent = generateICS(business, bookings || []);
    
    // Set headers for ICS file
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="linedup-${businessId}.ics"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    console.log(`✅ Calendar feed generated with ${bookings?.length || 0} events`);
    
    res.send(icsContent);
    
  } catch (error) {
    console.error('❌ Calendar feed error:', error);
    res.status(500).send('Error generating calendar');
  }
});

/**
 * Generate ICS file content
 */
function generateICS(business, bookings) {
  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LinedUp//Calendar//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:LinedUp - ${business.name}`,
    'X-WR-TIMEZONE:Asia/Jerusalem',
    // Timezone definition for Israel
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Jerusalem',
    'BEGIN:STANDARD',
    'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'TZOFFSETFROM:+0300',
    'TZOFFSETTO:+0200',
    'TZNAME:IST',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1FR',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0300',
    'TZNAME:IDT',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ];
  
  // Add each booking as an event
  for (const booking of bookings) {
    const event = generateEvent(booking, business);
    ics = ics.concat(event);
  }
  
  ics.push('END:VCALENDAR');
  
  return ics.join('\r\n');
}

/**
 * Generate a single VEVENT for a booking
 */
function generateEvent(booking, business) {
  const serviceName = booking.services?.name || 'תור';
  const clientName = booking.client_name || 'לקוח';
  const clientPhone = booking.client_phone || '';
  
  // Parse date and time
  const [year, month, day] = booking.date.split('-');
  const [hours, minutes] = booking.time.split(':');
  
  // Create start date
  const startDate = new Date(year, month - 1, day, hours, minutes);
  
  // Calculate end date based on duration (default 30 minutes)
  const duration = booking.duration || 30;
  const endDate = new Date(startDate.getTime() + duration * 60000);
  
  // Format dates for ICS
  const dtStart = formatICSDate(startDate);
  const dtEnd = formatICSDate(endDate);
  const dtStamp = formatICSDate(new Date());
  
  // Create unique ID
  const uid = `booking-${booking.id}@linedup.app`;
  
  // Build description
  let description = `לקוח: ${clientName}`;
  if (clientPhone) {
    description += `\\nטלפון: ${clientPhone}`;
  }
  if (booking.notes) {
    description += `\\nהערות: ${booking.notes}`;
  }
  const statusHe = booking.status === 'approved' || booking.status === 'confirmed' ? 'מאושר' : 'ממתין לאישור';
  description += `\\nסטטוס: ${statusHe}`;
  
  // Status emoji
  const statusEmoji = booking.status === 'approved' || booking.status === 'confirmed' ? '✅' : '⏳';
  
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;TZID=Asia/Jerusalem:${dtStart}`,
    `DTEND;TZID=Asia/Jerusalem:${dtEnd}`,
    `SUMMARY:${statusEmoji} ${serviceName} - ${clientName}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${business.name}`,
    `STATUS:${booking.status === 'approved' || booking.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
    'END:VEVENT',
  ];
}

/**
 * Format date for ICS (YYYYMMDDTHHmmss)
 */
function formatICSDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

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
        TWILIO_CONFIG.templateSid,
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
  console.log('\n🚀 LinedUp WhatsApp Service v2.1 Started');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📡 Supabase: ${SUPABASE_URL}`);
  console.log(`📱 Twilio WhatsApp: ${TWILIO_CONFIG.whatsappNumber}`);
  console.log('\n📡 Endpoints:');
  console.log('   GET  /health');
  console.log('   POST /api/otp/send');
  console.log('   POST /api/otp/verify');
  console.log('   POST /api/send-confirmation');
  console.log('   POST /api/send-update');
  console.log('   POST /api/send-waiting-list');
  console.log('   POST /api/send-broadcast');
  console.log('   GET  /cal/:businessId.ics');
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
