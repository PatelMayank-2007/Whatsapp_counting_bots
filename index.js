const express = require("express");
const app = express();

app.get("/", (req, res) => {
    res.send("Bot is running");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server started");
});




const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const crypto = require('crypto');
require('dotenv').config();

// ========================================
// SECURITY CONFIGURATION
// ========================================

// Environment validation
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;
if (!ADMIN_NUMBER || !/^\d{10,15}$/.test(ADMIN_NUMBER)) {
  console.error('❌ ERROR: ADMIN_NUMBER environment variable must be set and valid (10-15 digits)');
  process.exit(1);
}

// Allowed groups configuration
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS 
  ? process.env.ALLOWED_GROUPS.split(',').map(g => g.trim()).filter(g => g.length > 0)
  : [];

// Security limits
const RATE_LIMIT = {
  maxCommandsPerMinute: 10,
  maxCountValue: 10000,
  minCountValue: 0,
  maxExportsPerHour: 5,
  commandCooldown: 2000 // 2 seconds between commands per user
};

// Data directory with restricted permissions
const DATA_DIR = path.join(__dirname, 'data');

// Command history for rate limiting
const commandHistory = new Map(); // user -> [timestamps]
const exportHistory = new Map(); // user -> [timestamps]
const userCooldowns = new Map(); // user -> lastCommandTime

// QR generation counter (to avoid repeating full instructions on every refresh)
let qrCount = 0;

// Session lock to prevent concurrent modifications
const sessionLocks = new Map(); // chatId -> lock status

// ========================================
// SECURITY UTILITIES
// ========================================

/**
 * Sanitize input to prevent injection attacks
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  // Remove any potentially dangerous characters
  return input.replace(/[^\w\s\-.,!?@]/g, '').trim().substring(0, 500);
}

/**
 * Validate phone number format
 */
function isValidPhoneNumber(number) {
  return /^\d{10,15}$/.test(number);
}

/**
 * Rate limiting check
 */
function checkRateLimit(userId, limit = RATE_LIMIT.maxCommandsPerMinute) {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  
  if (!commandHistory.has(userId)) {
    commandHistory.set(userId, []);
  }
  
  const userHistory = commandHistory.get(userId);
  
  // Remove old timestamps
  const recentCommands = userHistory.filter(timestamp => timestamp > oneMinuteAgo);
  commandHistory.set(userId, recentCommands);
  
  if (recentCommands.length >= limit) {
    return false;
  }
  
  recentCommands.push(now);
  return true;
}

/**
 * Command cooldown check
 */
function checkCooldown(userId) {
  const now = Date.now();
  const lastCommand = userCooldowns.get(userId) || 0;
  
  if (now - lastCommand < RATE_LIMIT.commandCooldown) {
    return false;
  }
  
  userCooldowns.set(userId, now);
  return true;
}

/**
 * Export rate limiting (more restrictive)
 */
function checkExportLimit(userId) {
  const now = Date.now();
  const oneHourAgo = now - 360000;
  
  if (!exportHistory.has(userId)) {
    exportHistory.set(userId, []);
  }
  
  const userExports = exportHistory.get(userId);
  const recentExports = userExports.filter(timestamp => timestamp > oneHourAgo);
  exportHistory.set(userId, recentExports);
  
  if (recentExports.length >= RATE_LIMIT.maxExportsPerHour) {
    return false;
  }
  
  recentExports.push(now);
  return true;
}

/**
 * Verify admin with additional checks
 * Normalizes both numbers by stripping leading '+' before comparing
 */
function isAdmin(senderNumber) {
  if (!isValidPhoneNumber(senderNumber)) return false;
  const normalizedSender = senderNumber.replace(/^\+/, '');
  const normalizedAdmin = ADMIN_NUMBER.replace(/^\+/, '');
  return normalizedSender === normalizedAdmin;
}

/**
 * Acquire session lock for atomic operations
 */
async function acquireLock(chatId, maxWaitMs = 5000) {
  const startTime = Date.now();
  
  while (sessionLocks.get(chatId)) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error('Failed to acquire session lock');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  sessionLocks.set(chatId, true);
}

/**
 * Release session lock
 */
function releaseLock(chatId) {
  sessionLocks.delete(chatId);
}

/**
 * Hash sensitive data for logging
 */
function hashForLog(data) {
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Secure file path validation
 */
function isValidFilePath(filePath) {
  const normalized = path.normalize(filePath);
  return normalized.startsWith(DATA_DIR) && !normalized.includes('..');
}

// ========================================
// INITIALIZATION
// ========================================

// Create data directory with restricted permissions
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} else {
  // Ensure correct permissions on existing directory
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch (error) {
    console.warn('⚠️  Warning: Could not set directory permissions');
  }
}

// WhatsApp client with security-hardened configuration
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  }
});

// ========================================
// EVENT HANDLERS
// ========================================

client.on('qr', (qr) => {
  qrCount++;
  if (qrCount === 1) {
    console.log('\n🔐 QR CODE GENERATED - Scan with WhatsApp:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n📱 Raw QR string (for remote decode):\n', qr);
    console.log('\n⚠️  Paste the above string at https://qrcode.tec-it.com to generate scannable QR\n');
    console.log('🔒 Security: This QR code expires in 60 seconds and links YOUR WhatsApp only.\n');
  } else {
    console.log(`\n🔄 QR Code refreshed (attempt ${qrCount}) - scan quickly before it expires again\n`);
    qrcode.generate(qr, { small: true });
  }
});

client.on('ready', async () => {
  console.log('✅ Bot is ready and connected to WhatsApp!');
  console.log(`👤 Admin Number: ${ADMIN_NUMBER.substring(0, 4)}****${ADMIN_NUMBER.substring(ADMIN_NUMBER.length - 2)}`);
  
  // List all groups with security status
  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 WHATSAPP GROUPS STATUS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    let activeCount = 0;
    groups.forEach((group, index) => {
      const isAllowed = ALLOWED_GROUPS.length === 0 || ALLOWED_GROUPS.includes(group.name);
      const status = isAllowed ? '✅ ACTIVE' : '❌ IGNORED';
      if (isAllowed) activeCount++;
      console.log(`${index + 1}. ${status} - "${group.name}"`);
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    if (ALLOWED_GROUPS.length === 0) {
      console.log('⚠️  WARNING: No group restrictions - bot will work in ALL groups!');
      // console.log('   Set ALLOWED_GROUPS environment variable to restrict access.\n');
    } else {
      console.log(`🔒 Bot active in ${activeCount} groups only`);
      // console.log(`🚫 ${groups.length - activeCount} groups ignored\n`);
    }
    
  } catch (error) {
    console.error('Error listing groups:', error.message);
  }
});

client.on('authenticated', () => {
  console.log('🔓 Authentication successful!');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed Delete .wwebjs_auth folder and scan QR again:', msg);
  process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log(`⚠️  Client disconnected: ${reason}`);
  console.log('🔄 Attempting reconnection in 10 seconds...');
  
  // Clear all locks and rate limits on disconnect
  sessionLocks.clear();
  commandHistory.clear();
  exportHistory.clear();
  userCooldowns.clear();
  qrCount = 0;
  
  setTimeout(() => {
    client.initialize();
  }, 10000);
});

// ========================================
// MESSAGE HANDLER WITH SECURITY
// ========================================

client.on('message', async (msg) => {
  let chatId = null;
  
  try {
    const chat = await msg.getChat();
    
    // Only process group messages
    if (!chat.isGroup) return;
    
    chatId = chat.id._serialized;
    
    // Group whitelist check
    if (ALLOWED_GROUPS.length > 0 && !ALLOWED_GROUPS.includes(chat.name)) {
      return; // Silently ignore non-whitelisted groups
    }
    
    const contact = await msg.getContact();
    const senderNumber = contact.id.user;
    
    // Validate sender number
    if (!isValidPhoneNumber(senderNumber)) {
      // console.warn(`⚠️  Invalid sender number format: ${hashForLog(senderNumber)}`);
      return;
    }
    
    // Sanitize message body
    const messageBody = sanitizeInput(msg.body);
    
    if (!messageBody) return; // Ignore empty/invalid messages
    
    // Rate limiting check
    if (!checkRateLimit(senderNumber)) {
      // await msg.reply('⏱️ Too many commands. Please wait a minute before trying again.');
      // console.warn(`⚠️  Rate limit exceeded: ${hashForLog(senderNumber)} in group ${chat.name}`);
      return;
    }
    
    // Cooldown check
    if (!checkCooldown(senderNumber)) {
      return; // Silent cooldown, no message
    }
    
    // Command routing
    if (messageBody.startsWith('!count ')) {
      await handleCount(msg, chat, senderNumber, messageBody);
    } else if (/^\d+/.test(messageBody) && !/^!\w/.test(messageBody)) {
      // Format: starts with number e.g. "10Dharmik", "10 Dharmik"
      await handleCount(msg, chat, senderNumber, `!count ${messageBody.match(/^(\d+)/)[1]}`);
    } else if (/\s\d+$/.test(messageBody) && !/^!\w/.test(messageBody)) {
      // Format: ends with number e.g. "Dharmik 10"
      await handleCount(msg, chat, senderNumber, `!count ${messageBody.match(/(\d+)$/)[1]}`);
    } else if (/-\d+$/.test(messageBody) && !/^!\w/.test(messageBody)) {
      // Format: ends with number e.g. "Dharmik-10"
      const number = messageBody.match(/(\d+)$/)[1];
      await handleCount(msg, chat, senderNumber, `!count ${number}`);
    } else if (/^\d+-/.test(messageBody) && !/^!\w/.test(messageBody)) {
      // Format: ends with number e.g. "10-Dharmik"
      const number = messageBody.match(/^(\d+)/)[1];
      await handleCount(msg, chat, senderNumber, `!count ${number}`);
    } else if (/^\d+$/.test(messageBody)) {
      // Format: plain number only e.g. "42"
      await handleCount(msg, chat, senderNumber, `!count ${messageBody}`);
    } else if (messageBody.includes('\n') && !/^!\w/.test(messageBody)) {
      // Format: multiline e.g. "Dharmik\n10" or "10\nDharmik"
      const lines = messageBody.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const numberLine = lines.find(l => /^\d+$/.test(l));
      if (numberLine) {
        await handleCount(msg, chat, senderNumber, `!count ${numberLine}`);
      }
    } else if (messageBody === '!total') {
      await handleTotal(msg, chat, chatId);
    } else if (messageBody === '!export') {
      await handleExport(msg, chat, chatId, senderNumber);
    } else if (messageBody === '!reset') {
      await handleReset(msg, chat, chatId, senderNumber);
    } else if (messageBody === '!help') {
      await handleHelp(msg);
    } else if (messageBody === '!status' && isAdmin(senderNumber)) {
      await handleStatus(msg, chat);
    }
    
  } catch (error) {
    console.error(`❌ Error handling message: ${error.message}`);
    
    // Release lock if error occurred
    if (chatId) {
      releaseLock(chatId);
    }
    
    try {
      // await msg.reply('❌ An error occurred. Please try again later.');
    } catch (replyError) {
      console.error('Failed to send error message:', replyError.message);
    }
  }
});

// ========================================
// COMMAND HANDLERS WITH SECURITY
// ========================================

async function handleCount(msg, chat, senderNumber, messageBody) {
  const chatId = chat.id._serialized;
  
  try {
    // Parse and validate count
    const countMatch = messageBody.match(/!count\s+(\d+)/);
    
    if (!countMatch) {
      return 0;
      // msg.reply('❌ Invalid format. Use: !count <number>\nExample: !count 5');
    }
    
    const count = parseInt(countMatch[1], 10);
    
    // Validate count range
    if (isNaN(count) || count < RATE_LIMIT.minCountValue || count > RATE_LIMIT.maxCountValue) {
      return 0;
      // msg.reply(`❌ Count must be between ${RATE_LIMIT.minCountValue} and ${RATE_LIMIT.maxCountValue}`);
    }
    
    // Acquire lock for atomic operation
    await acquireLock(chatId);
    
    try {
      const db = loadDatabase(chatId);
      const contact = await msg.getContact();
      const userName = sanitizeInput(contact.pushname || 'Unknown');
      
      // Store count (overwrites previous)
      db[senderNumber] = {
        count: count,
        name: userName,
        timestamp: new Date().toISOString()
      };
      
      saveDatabase(chatId, db);
      
      // await msg.reply(`✅ Count recorded: ${count}\n📊 Use !total to see leaderboard`);
      
      console.log(`📝 Count recorded: ${userName} (${hashForLog(senderNumber)}) = ${count} in ${chat.name}`);
      
    } finally {
      releaseLock(chatId);
    }
    
  } catch (error) {
    releaseLock(chatId);
    throw error;
  }
}

async function handleTotal(msg, chat, chatId) {
  try {
    const db = loadDatabase(chatId);
    const entries = Object.entries(db);
    
    if (entries.length === 0) {
      return msg.reply('📊 No counts recorded yet!\nUse !count <number> to start.');
    }
    
    // Sort by count descending
    entries.sort((a, b) => b[1].count - a[1].count);
    
    let leaderboard = `📊 *${chat.name}*\n`;
    leaderboard += `━━━━━━━━━━━━━━━━\n\n`;
    
    let totalSum = 0;
    
    entries.slice(0, 10).forEach(([, data], index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      leaderboard += `${medal} ${data.name}: *${data.count}*\n`;
      totalSum += data.count;
    });
    
    // Add remaining counts to total if there are more than 10
    if (entries.length > 10) {
      entries.slice(10).forEach(([, data]) => {
        totalSum += data.count;
      });
      leaderboard += `\n_... and ${entries.length - 10} more_\n`;
    }
    
    leaderboard += `\n━━━━━━━━━━━━━━━━\n`;
    leaderboard += `🎯 *Total: ${totalSum}*\n`;
    leaderboard += `👥 *Participants: ${entries.length}*`;
    
    await msg.reply(leaderboard);
    
  } catch (error) {
    throw error;
  }
}

async function handleExport(msg, chat, chatId, senderNumber) {
  try {
    // Admin verification
    if (!isAdmin(senderNumber)) {
      await msg.reply('❌ Only admin can export data.');
      return;
    }

    // Export rate limiting
    if (!checkExportLimit(senderNumber)) {
      await msg.reply('⏱️ Export limit reached. Please wait before exporting again.');
      return;
    }

    // ── Collect data from ALL group database files ──────────────────────────
    const allFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('counts_') && f.endsWith('.json'));

    if (allFiles.length === 0) {
      return msg.reply('📊 No data to export.');
    }

    // Build a chatId → group name map from the live client
    const groupNameMap = {};
    try {
      const chats = await client.getChats();
      chats.filter(c => c.isGroup).forEach(c => {
        groupNameMap[c.id._serialized] = c.name;
      });
    } catch (e) {
      console.warn('⚠️  Could not fetch group names:', e.message);
    }

    // Derive chatId from filename: counts_<sanitized chatId>.json
    // getDatabasePath sanitizes with replace(/[^a-zA-Z0-9@._-]/g, '_')
    // We stored the sanitized form, so we match by scanning groupNameMap keys
    function fileNameToChatId(fileName) {
      const sanitized = fileName.replace('counts_', '').replace('.json', '');
      // Try to find the original chatId whose sanitized form matches
      const match = Object.keys(groupNameMap).find(id => id.replace(/[^a-zA-Z0-9@._-]/g, '_') === sanitized);
      return match || sanitized;
    }

    // ── Build Excel rows ─────────────────────────────────────────────────────
    const worksheetData = [
      ['Group', 'Rank', 'Name', 'Phone Number', 'Count', 'Recorded At']
    ];

    let grandTotal = 0;
    let grandParticipants = 0;
    let hasAnyData = false;
    const groupSummaries = []; // for the WhatsApp text reply

    for (const file of allFiles) {
      const fileChatId = fileNameToChatId(file);
      const groupName = groupNameMap[fileChatId] || fileChatId;
      const db = loadDatabase(fileChatId);
      const entries = Object.entries(db);

      if (entries.length === 0) continue;
      hasAnyData = true;

      entries.sort((a, b) => b[1].count - a[1].count);

      let groupTotal = 0;
      entries.forEach(([number, data], index) => {
        worksheetData.push([
          groupName,
          index + 1,
          data.name,
          number,
          data.count,
          data.timestamp
        ]);
        groupTotal += data.count;
      });

      // Group subtotal row
      worksheetData.push(['', '', '', `── ${groupName} subtotal ──`, groupTotal, '']);

      grandTotal += groupTotal;
      grandParticipants += entries.length;
      groupSummaries.push({ groupName, groupTotal, count: entries.length });
    }

    if (!hasAnyData) {
      return msg.reply('📊 No data to export across any group.');
    }

    // Grand total row
    worksheetData.push(['', '', '', '══ GRAND TOTAL ══', grandTotal, '']);

    // ── Write Excel ──────────────────────────────────────────────────────────
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

    // Bold the header row and total rows (basic column widths)
    worksheet['!cols'] = [
      { wch: 25 }, // Group
      { wch: 6 },  // Rank
      { wch: 20 }, // Name
      { wch: 18 }, // Phone
      { wch: 8 },  // Count
      { wch: 26 }, // Recorded At
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'All Groups');

    const timestamp = Date.now();
    const fileName = `export_all_${timestamp}.xlsx`;
    const filePath = path.join(DATA_DIR, fileName);

    if (!isValidFilePath(filePath)) {
      throw new Error('Invalid file path detected');
    }

    XLSX.writeFile(workbook, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (e) {
      console.warn('⚠️  Could not set file permissions');
    }

    // ── WhatsApp text summary ────────────────────────────────────────────────
    let summary = `📤 *Full Export — All Groups*\n\n`;
    groupSummaries.forEach(({ groupName, groupTotal, count }) => {
      summary += `📌 *${groupName}*\n`;
      summary += `   👥 Participants: ${count}  |  🎯 Total: ${groupTotal}\n\n`;
    });
    summary += `━━━━━━━━━━━━━━━━\n`;
    summary += `🏆 *Grand Total: ${grandTotal}*\n`;
    summary += `👥 *Total Participants: ${grandParticipants}*`;

    await msg.reply(summary);

    // ── Send Excel file ──────────────────────────────────────────────────────
    const { MessageMedia } = require('whatsapp-web.js');
    const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
    const mediaFile = new MessageMedia(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileData,
      fileName
    );

    await chat.sendMessage(mediaFile, {
      caption: ''
    });

    // Secure cleanup
    const randomData = crypto.randomBytes(fs.statSync(filePath).size);
    fs.writeFileSync(filePath, randomData);
    fs.unlinkSync(filePath);

    console.log(`📤 Export completed by admin in ${chat.name}`);
  } catch (error) {
    throw error;
  }
}

async function handleReset(msg, chat, chatId, senderNumber) {
  try {
    // Admin verification
    if (!isAdmin(senderNumber)) {
      await msg.reply('❌ Only admin can reset data.');
      return;
    }

    await acquireLock(chatId);

    try {
      const dbPath = getDatabasePath(chatId);

      if (fs.existsSync(dbPath)) {
        // Clear database — no backup
        saveDatabase(chatId, {});
        await msg.reply(`🗑️ All counts cleared!`);
      } else {
        await msg.reply('📊 No data to reset.');
      }
    } finally {
      releaseLock(chatId);
    }
  } catch (error) {
    releaseLock(chatId);
    throw error;
  }
}

async function handleHelp(msg) {
  const helpText = `
🤖 *WhatsApp Count Bot*
━━━━━━━━━━━━━━━━

📝 *Commands:*
!count <number> - Record count
!total - View leaderboard
!help - Show this message

🔐 *Admin Only:*
!export - Get Excel file
!reset - Clear all counts
!status - View bot status

💡 *Examples:*
!count 5
!count 42

🛡️ *Security: All commands are rate-limited*
  `.trim();
  
  await msg.reply(helpText);
}

async function handleStatus(msg, chat) {
  try {
    const chatId = chat.id._serialized;
    const db = loadDatabase(chatId);
    const entries = Object.entries(db);
    
    let status = `📊 *Bot Status - ${chat.name}*\n\n`;
    status += `👥 Participants: ${entries.length}\n`;
    status += `📝 Total Counts: ${entries.reduce((sum, [, data]) => sum + data.count, 0)}\n`;
    status += `⏱️ Active Rate Limits: ${commandHistory.size}\n`;
    status += `🔒 Security: Enabled\n`;
    status += `✅ Status: Operational`;
    
    await msg.reply(status);
    
  } catch (error) {
    throw error;
  }
}

// ========================================
// SECURE DATABASE OPERATIONS
// ========================================

function getDatabasePath(chatId) {
  // Sanitize chatId to prevent path traversal
  const sanitized = chatId.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const dbPath = path.join(DATA_DIR, `counts_${sanitized}.json`);
  
  // Validate the path is within DATA_DIR
  if (!isValidFilePath(dbPath)) {
    throw new Error('Invalid database path');
  }
  
  return dbPath;
}

function loadDatabase(chatId) {
  const dbPath = getDatabasePath(chatId);
  
  if (fs.existsSync(dbPath)) {
    try {
      const data = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validate structure
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`⚠️  Invalid database structure in ${dbPath}, resetting`);
        return {};
      }
      
      // Validate each entry
      const validated = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          isValidPhoneNumber(key) &&
          value &&
          typeof value.count === 'number' &&
          typeof value.name === 'string' &&
          typeof value.timestamp === 'string'
        ) {
          validated[key] = value;
        }
      }
      
      return validated;
      
    } catch (error) {
      console.error(`❌ Error loading database ${dbPath}:`, error.message);
      return {};
    }
  }
  
  return {};
}

function saveDatabase(chatId, data) {
  const dbPath = getDatabasePath(chatId);
  
  try {
    // Validate data before saving
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid data structure');
    }
    
    // Write to temporary file first
    const tempPath = `${dbPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    
    // Set secure permissions
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch (error) {
      console.warn('⚠️  Could not set file permissions');
    }
    
    // Atomic rename
    fs.renameSync(tempPath, dbPath);
    
  } catch (error) {
    console.error(`❌ Error saving database ${dbPath}:`, error.message);
    throw error;
  }
}

// ========================================
// CLEANUP & STARTUP
// ========================================

// ========================================
// START THE BOT
// ========================================

console.log('🚀 WhatsApp Count Bot - Secure Edition');

console.log('🌐 Initializing WhatsApp client...\n');
client.initialize();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  
  // Clear sensitive data from memory
  commandHistory.clear();
  exportHistory.clear();
  userCooldowns.clear();
  sessionLocks.clear();
  
  try {
    await client.destroy();
    console.log('✅ Client disconnected safely');
  } catch (error) {
    console.error('Error during shutdown:', error.message);
  }
  
  console.log('👋 Goodbye!\n');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  await client.destroy();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});