# Discord Bot Integration

Interactive Discord bot for server monitoring, system status checks, and server management.

## Features

- 🤖 **Interactive Bot** - Slash commands for querying server status
- 📊 **Real-time Monitoring** - Get instant server health information
- 🔔 **DM Notifications** - Receive personal alerts for critical issues
- 👋 **Onboarding** - Automatic welcome message when bot joins
- 🎯 **Permission System** - Role-based access control (coming soon)
- 📈 **Incident Tracking** - View and track system incidents

## Quick Start

### Option 1: Webhooks Only (Simple)

If you just want channel notifications without the interactive bot:

```env
NOTIFICATION_1_TYPE=discord
NOTIFICATION_1_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

See [main README](../README.md) for webhook setup.

### Option 2: Full Interactive Bot (Advanced)

For slash commands, DMs, and server management capabilities.

## Bot Setup Guide

### Step 1: Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name your application (e.g., "Server Monitor Bot")
4. Click **Create**

### Step 2: Create Bot User

1. In your application, go to the **Bot** tab
2. Click **Add Bot** → **Yes, do it!**
3. Under **Token**, click **Reset Token** and **Copy**
   - ⚠️ **IMPORTANT**: Save this token securely! You won't see it again
   - This is your `DISCORD_BOT_TOKEN`
4. Scroll down to **Privileged Gateway Intents**
   - Enable **MESSAGE CONTENT INTENT** (if you want the bot to read messages)
   - Enable **SERVER MEMBERS INTENT** (if you want member info)
5. Click **Save Changes**

### Step 3: Get Client ID

1. Go to **OAuth2** → **General**
2. Copy your **CLIENT ID**
   - This is your `DISCORD_CLIENT_ID`

### Step 4: Generate Bot Invite URL

1. Go to **OAuth2** → **URL Generator**
2. Select scopes:
   - ☑️ `bot`
   - ☑️ `applications.commands`
3. Select bot permissions:
   - ☑️ Send Messages
   - ☑️ Embed Links
   - ☑️ Read Message History
   - ☑️ Use Slash Commands
4. Copy the generated URL at the bottom
5. Open the URL in a browser and select your server

### Step 5: Configure Environment Variables

Add these to your `.env` file:

```env
# Discord Bot Configuration (Required)
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-client-id-here

# Server API Configuration (Required)
SERVER_API_URL=http://localhost:3000
SERVER_API_KEY=your-webhook-id-here

# Optional: Guild-specific commands (faster deployment for testing)
DISCORD_GUILD_ID=your-server-id-here

# Optional: User IDs for DM notifications (comma-separated)
DISCORD_NOTIFY_USERS=123456789012345678,987654321098765432
```

**How to get Guild ID:**
1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click your server → Copy Server ID

**How to get User IDs:**
1. Enable Developer Mode
2. Right-click user → Copy User ID

### Step 6: Start the Bot

#### Option A: Standalone Bot

```bash
node node/integrations/discord/start-bot.mjs
```

Or add to `package.json`:
```json
{
  "scripts": {
    "discord-bot": "node node/integrations/discord/start-bot.mjs"
  }
}
```

Then run:
```bash
npm run discord-bot
```

#### Option B: With Main Server

Import and initialize in your main app:

```javascript
import { DiscordBotAdapter } from './integrations/discord/bot.mjs';

const discordBot = new DiscordBotAdapter();
await discordBot.initialize();
```

## Available Commands

### 📊 Monitoring Commands

#### `/status`
Check current server health status

**Options:**
- `detailed` (optional): Show detailed metrics
- `ephemeral` (optional): Show response only to you

**Examples:**
```
/status
/status detailed:true
/status ephemeral:false
```

#### `/ping`
Check if the bot is responsive

### 🔧 Utility Commands

#### `/help`
Get help with bot commands

**Options:**
- `command` (optional): Get help for a specific command

**Examples:**
```
/help
/help command:status
```

## Onboarding Message

When the bot joins a new server, it automatically sends a welcome message with:
- Overview of bot capabilities
- Getting started guide
- Interactive buttons for setup
- Link to documentation

## Direct Message Notifications

### Setup DM Notifications

1. Add user IDs to environment:
```env
DISCORD_NOTIFY_USERS=123456789012345678,987654321098765432
```

2. Users must:
   - Share a server with the bot, OR
   - Allow DMs from server members

3. Bot will automatically send DMs for:
   - Critical system alerts
   - Heavy load warnings
   - Incident updates

### DM Message Format

```
🚨 Server Alert: CRITICAL
System resources are critically constrained. CPU at 95%.

💻 CPU Usage: 95.2%
🧠 Memory Usage: 87.3%
💾 Disk Usage: 45.1%

🚨 Incident ID: incident-1698765432
⏱️ Started: 2 hours ago
```

## Architecture

```
┌─────────────────────┐
│   Discord Client    │
│   (Users/Channels)  │
└──────────┬──────────┘
           │ Slash Commands
           │ Button Clicks
           ↓
┌─────────────────────┐
│   Discord Bot       │
│   (bot.mjs)         │
└──────────┬──────────┘
           │ HTTP/WS
           ↓
┌─────────────────────┐
│   Your Node Server  │
│   (System Status)   │
└─────────────────────┘
```

## File Structure

```
node/integrations/discord/
├── index.mjs               # Exports webhook & bot adapters
├── webhook.mjs             # Webhook adapter (channel posts)
├── bot.mjs                 # Bot adapter (interactive)
├── start-bot.mjs           # Standalone bot starter
├── commands/               # Slash commands
│   ├── status.mjs          # /status command
│   ├── help.mjs            # /help command
│   └── ping.mjs            # /ping command
├── events/                 # Event handlers
│   ├── ready.mjs           # Bot ready event
│   ├── guildCreate.mjs     # Server join event (onboarding)
│   └── interactionCreate.mjs # Command/button handler
├── utils/                  # Utilities
│   └── serverApi.mjs       # API client for backend
└── README.md               # This file
```

## Adding New Commands

1. Create new file in `commands/`:

```javascript
// commands/restart.mjs
import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('restart')
  .setDescription('Restart a service')
  .addStringOption(option =>
    option
      .setName('service')
      .setDescription('Service to restart')
      .setRequired(true)
      .addChoices(
        { name: 'API Server', value: 'api' },
        { name: 'Transcoder', value: 'transcoder' }
      )
  );

export async function execute(interaction, client) {
  // Check permissions
  if (!interaction.member.permissions.has('ADMINISTRATOR')) {
    return interaction.reply({
      content: '❌ You need Administrator permission',
      ephemeral: true
    });
  }
  
  const service = interaction.options.getString('service');
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Call your API to restart service
    const apiClient = new ServerApiClient(
      client.botAdapter.serverApiUrl,
      client.botAdapter.serverApiKey
    );
    
    // await apiClient.restartService(service);
    
    await interaction.editReply(`✅ Service ${service} restarted successfully`);
  } catch (error) {
    await interaction.editReply(`❌ Failed to restart service: ${error.message}`);
  }
}
```

2. Bot will automatically load it on next restart

## Troubleshooting

### Bot doesn't respond to commands

**Check:**
1. Bot token is correct in `.env`
2. Bot has required permissions
3. Commands are registered (check bot logs)
4. Bot is actually online in your server

**Solution:**
```bash
# Restart bot
npm run discord-bot
```

### Commands don't appear

**Issue**: Slash commands can take up to 1 hour to register globally

**Solution**: Use guild-specific registration for testing:
```env
DISCORD_GUILD_ID=your-server-id-here
```

### Bot can't send DMs

**Check:**
1. User has DMs enabled for server members
2. Bot shares a server with the user
3. User ID is correct in `DISCORD_NOTIFY_USERS`

### API calls fail

**Check:**
1. `SERVER_API_URL` points to running server
2. `SERVER_API_KEY` is valid webhook ID
3. Server is accessible from bot (network/firewall)

**Test API manually:**
```bash
curl http://localhost:3000/api/system-status \
  -H "X-Webhook-ID: your-webhook-id"
```

## Security Best Practices

1. **Never commit tokens** to version control
   - Add `.env` to `.gitignore`
   - Use environment variables

2. **Rotate tokens periodically**
   - Reset bot token in Developer Portal
   - Update `.env` file

3. **Use role-based permissions**
   - Restrict sensitive commands to admins
   - Check permissions before executing

4. **Validate API responses**
   - Don't trust external data
   - Handle errors gracefully

5. **Rate limiting**
   - Respect Discord's rate limits
   - Cache API responses when possible

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | ✅ | Bot token from Developer Portal | `MTIzNDU2...` |
| `DISCORD_CLIENT_ID` | ✅ | Application client ID | `123456789012345678` |
| `SERVER_API_URL` | ✅ | Your backend API URL | `http://localhost:3000` |
| `SERVER_API_KEY` | ✅ | Webhook ID for authentication | `webhook-123` |
| `DISCORD_GUILD_ID` | ❌ | Server ID for fast command deployment | `987654321098765432` |
| `DISCORD_NOTIFY_USERS` | ❌ | Comma-separated user IDs for DMs | `123,456,789` |
| `DEBUG` | ❌ | Enable debug logging | `TRUE` |

## Support

- 📚 [Discord.js Documentation](https://discord.js.org/)
- 💬 [Discord.js Support Server](https://discord.gg/djs)
- 📖 [Discord Developer Docs](https://discord.com/developers/docs)
- 🐛 [Report Issues](https://github.com/your-repo/issues)

## License

Same as parent project.