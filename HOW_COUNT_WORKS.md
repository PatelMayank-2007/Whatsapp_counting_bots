# How the Count System Works

## Command Format

The bot accepts **six formats** for submitting a count:

### Format 1 — Plain number only
```
42
```

### Format 2 — Number first, name attached (no space)
```
10Dharmik
```

### Format 3 — Number first, name after (with space)
```
10 Dharmik
```

### Format 4 — Name first, number at the end
```
Dharmik 10
```

### Format 5 — Multiline: name on first line, count on second
```
Dharmik
10
```

### Format 6 — Multiline: count on first line, name on second
```
10
Dharmik
```

### Format 7 — Name first,hypen second,number at the end
```
Dharmik-10
```

### Format 8 — Number first,hypen second,Name at the end
```
10-Dharmik
```

### Format 7 — Explicit command
```
!count 10
```

In all formats, the bot extracts only the **number** as the count. Your WhatsApp display name is used automatically — the name written in the message is ignored.

---

## Can a User Send Just a Number Without `!count`?

**Yes**, the bot supports natural message formats where a number appears anywhere in the message — same line or separate line.

### What gets recognized vs ignored

| Message Sent | Count Recorded | Notes |
|--------------|---------------|-------|
| `42` ✅ | 42 | Plain number |
| `10Dharmik` ✅ | 10 | Number + name, no space |
| `10 Dharmik` ✅ | 10 | Number + name, with space |
| `Dharmik 10` ✅ | 10 | Name + number |
| `Dharmik` + newline + `10` ✅ | 10 | Multiline, name first |
| `10` + newline + `Dharmik` ✅ | 10 | Multiline, number first |
| `!count 42` ✅ | 42 | Explicit command |
| `!Count 42` | Ignored | Capital C not recognized |
| `count 42` | Ignored | Missing `!` prefix |

---

## Full Process — Step by Step

### 1. User Sends a Count
A group member sends `!count 25` in the WhatsApp group.

### 2. Bot Validates the Message
The bot checks:
- Is the message from a **whitelisted group**? (set via `ALLOWED_GROUPS` in `.env`)
- Is the sender's phone number in a **valid format**?
- Has the user exceeded the **rate limit** (max 10 commands per minute)?
- Is the user within the **cooldown period** (2 seconds between commands)?

If any check fails, the command is silently ignored or a warning is sent back.

### 3. Count is Parsed and Validated
The bot extracts the number from the message using the pattern `!count <digits>`.
- If the format is wrong → replies: `❌ Invalid format. Use: !count <number>`
- If the number is out of range (below 0 or above 10,000) → replies with the allowed range

### 4. Count is Saved
The bot:
1. Acquires a **session lock** on the group to prevent race conditions
2. Loads the group's database (a JSON file stored in the `data/` folder)
3. Saves the count under the sender's phone number — **overwrites any previous count**
4. Releases the lock

Each record stores:
```json
{
  "919876543210": {
    "count": 25,
    "name": "John",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### 5. Confirmation Sent
Bot replies: `✅ Count recorded: 25` and suggests using `!total` to see the leaderboard.

---

## Important Rules

| Rule | Detail |
|------|--------|
| One count per user | Each new `!count` **replaces** the previous one, not adds to it |
| Number range | Must be between **0 and 10,000** |
| Rate limit | Max **10 commands per minute** per user |
| Cooldown | **2 seconds** must pass between any two commands |
| Groups only | Bot ignores all private/direct messages |
| Whitelisted groups | Bot only responds in groups listed in `ALLOWED_GROUPS` |

---

## Other Commands

| Command | Who Can Use | What It Does |
|---------|-------------|--------------|
| `!count <number>` | Everyone | Submit or update your count |
| `!total` | Everyone | View the leaderboard (top 10) |
| `!help` | Everyone | Show available commands |
| `!export` | Admin only | Download full data as Excel file |
| `!reset` | Admin only | Clear all counts (backup is created) |
| `!status` | Admin only | View bot stats for the group |

---

## Leaderboard (`!total`)

Shows the top 10 participants ranked by count, with medals for top 3:

```
📊 Group Name
━━━━━━━━━━━━━━━━

🥇 Alice: 980
🥈 Bob: 750
🥉 Charlie: 600
4. Dave: 450
...

━━━━━━━━━━━━━━━━
🎯 Total: 4200
👥 Participants: 12
```

---

## Data Storage

- Each group has its own JSON file in the `data/` folder
- File is named using a hashed version of the group ID (e.g., `counts_xxxxx.json`)
- Files are never exposed publicly and are excluded from git via `.gitignore`
- On `!reset`, a backup is created before clearing — backups older than 30 days are auto-deleted on startup

---

## Common Mistakes

| Mistake | Result |
|---------|--------|
| `Dharmik` (name only, no number anywhere) | Ignored silently |
| `!Count 5` (capital C) | Not recognized |
| `!count5` (no space in explicit format) | Not recognized |
| `!count 5.5` (decimal) | Not recognized |
| `!count 99999` (over limit) | Rejected with range error |
| Sending in DM | Ignored silently |
| Sending in non-whitelisted group | Ignored silently |
