# External Integrations

This directory contains adapters for sending system status notifications to external platforms like Discord, Slack, email, etc.

## Architecture

```
integrations/
├── index.mjs          # NotificationManager - Central hub for all notifications
├── discord.mjs        # Discord webhook adapter
└── README.md          # This file
```

## Supported Platforms

### ✅ Discord (Webhooks)
Send rich embed notifications to Discord channels via webhooks.

### ✅ Frontend (Legacy)
Send HTTP POST notifications to frontend applications (backward compatible).

### 🚧 Coming Soon
- Slack webhooks
- Telegram bot
- Email (SMTP)
- SMS (Twilio/AWS SNS)
- Microsoft Teams

## Configuration

### Option 1: Unified Notification Format (Recommended)

Configure notifications using the `NOTIFICATION_X_*` environment variable pattern:

```env
# Discord webhook
NOTIFICATION_1_TYPE=discord
NOTIFICATION_1_URL=https://discord.com/api/webhooks/1234567890/abcdefghijklmnop

# Another Discord webhook (different channel)
NOTIFICATION_2_TYPE=discord
NOTIFICATION_2_URL=https://discord.com/api/webhooks/0987654321/zyxwvutsrqponmlk

# Frontend webhook
NOTIFICATION_3_TYPE=frontend
NOTIFICATION_3_URL=https://frontend.example.com
NOTIFICATION_3_WEBHOOK_ID=your-webhook-id-here

# Optional: Custom cooldown per notification (in milliseconds)
NOTIFICATION_1_COOLDOWN=300000  # 5 minutes
```

### Option 2: Legacy Frontend Format (Backward Compatible)

The system still supports the original frontend webhook format:

```env
FRONT_END_1=https://frontend1.example.com
WEBHOOK_ID_1=webhook-id-123

FRONT_END_2=https://frontend2.example.com
WEBHOOK_ID_2=webhook-id-456
```

**Note:** Both formats can be used simultaneously. The NotificationManager will send to all configured channels.

## Discord Setup Guide

### Step 1: Create Discord Webhook

1. Open your Discord server
2. Navigate to **Server Settings** → **Integrations** → **Webhooks**
3. Click **New Webhook**
4. Configure the webhook:
   - **Name**: System Monitor (or your preferred name)
   - **Channel**: Select the channel for notifications
   - **Avatar**: Optional custom avatar
5. Click **Copy Webhook URL**

### Step 2: Configure Environment Variables

Add the webhook URL to your `.env` file:

```env
NOTIFICATION_1_TYPE=discord
NOTIFICATION_1_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### Step 3: Test the Integration

You can test the webhook using the manual trigger endpoint:

```bash
curl -X POST http://localhost:3000/api/trigger-system-status \
  -H "X-Webhook-ID: your-webhook-id" \
  -H "Content-Type: application/json" \
  -d '{"forceStatus": "heavy", "message": "Test notification"}'
```

### Discord Message Format

Notifications appear as rich embeds with:
- **Title**: System status with emoji (✅ Normal, ⚠️ Elevated, 🔶 Heavy, 🚨 Critical)
- **Description**: Detailed status message
- **Color**: Green (normal), Yellow (elevated), Orange (heavy), Red (critical)
- **Fields**: CPU, Memory, Disk usage, Disk I/O stats
- **Incident Info**: Incident ID and duration (if active)
- **Footer**: Server URL for identification
- **Timestamp**: When the notification was sent

## Notification Cooldowns

To prevent spam, the system implements cooldown periods between notifications:

- **Critical**: 2 minutes (120,000ms)
- **Heavy**: 5 minutes (300,000ms)
- **Elevated**: 10 minutes (600,000ms)

These can be overridden per-channel using the `NOTIFICATION_X_COOLDOWN` environment variable.

## Adding New Platforms

To add support for a new platform (e.g., Slack):

### 1. Create Adapter File

Create `node/integrations/slack.mjs`:

```javascript
import axios from 'axios';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('slackIntegration');

export class SlackAdapter {
  async send(webhookUrl, status, message, metrics, incident, serverUrl) {
    // Format message for Slack
    const payload = {
      text: `System Status: ${status}`,
      blocks: [
        // Slack Block Kit formatting
      ]
    };
    
    const response = await axios.post(webhookUrl, payload);
    return { success: response.status === 200, platform: 'slack' };
  }
}
```

### 2. Register in NotificationManager

Update `node/integrations/index.mjs`:

```javascript
import { SlackAdapter } from './slack.mjs';

export class NotificationManager {
  constructor() {
    this.discordAdapter = new DiscordAdapter();
    this.slackAdapter = new SlackAdapter();  // Add this
  }
  
  async sendToChannel(channel, status, message, statusData, incident, serverUrl) {
    switch (channel.type) {
      case 'discord':
        return await this.discordAdapter.send(...);
      case 'slack':  // Add this case
        return await this.slackAdapter.send(...);
      case 'frontend':
        return await this.sendToFrontend(...);
    }
  }
}
```

### 3. Configure and Test

```env
NOTIFICATION_4_TYPE=slack
NOTIFICATION_4_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

## Troubleshooting

### Discord Webhook Not Working

**Issue**: Notifications not appearing in Discord

**Solutions**:
1. Verify webhook URL is correct and complete
2. Check Discord webhook hasn't been deleted
3. Ensure bot has permission to post in the channel
4. Check server logs for error messages
5. Test webhook directly: `curl -X POST "YOUR_WEBHOOK_URL" -H "Content-Type: application/json" -d '{"content":"Test"}'`

### Rate Limiting

**Issue**: Too many notifications being sent

**Solutions**:
1. Adjust cooldown periods in environment variables
2. Increase thresholds (CPU/Memory/Disk percentages)
3. Disable monitoring for specific resources: `SYSTEM_STATUS_MONITOR_CPU=FALSE`

### Multiple Identical Notifications

**Issue**: Same notification sent multiple times

**Solutions**:
1. Verify you don't have duplicate entries in environment variables
2. Check cooldown system is working (should prevent duplicates)
3. Review scheduled job frequency (default: 60 seconds)

## Security Best Practices

1. **Never commit webhook URLs** to version control
2. Store all webhook URLs in `.env` file (gitignored)
3. Use environment variables for sensitive data
4. Rotate webhook URLs periodically
5. Use different webhooks for different environments (dev/staging/prod)
6. Monitor webhook usage for suspicious activity

## API Reference

### NotificationManager

Main class that handles all notification dispatching.

#### `getNotificationChannels()`
Returns array of all configured notification channels from environment variables.

#### `sendNotifications(status, message, statusData, incident, serverUrl, cooldowns, cooldownLimits)`
Sends notifications to all configured channels, respecting cooldown periods.

**Parameters:**
- `status` (string): System status level
- `message` (string): Detailed message
- `statusData` (object): Complete system metrics
- `incident` (object): Current incident info
- `serverUrl` (string): Server identifier
- `cooldowns` (object): Cooldown tracker
- `cooldownLimits` (object): Cooldown limits by status

**Returns:** `Promise<{sent, failed, skipped, total}>`

### DiscordAdapter

Adapter for Discord webhook notifications.

#### `send(webhookUrl, status, message, metrics, incident, serverUrl)`
Sends formatted embed to Discord webhook.

#### `static isValidWebhookUrl(url)`
Validates if URL is a valid Discord webhook URL.

## Examples

### Multiple Discord Channels

Send critical alerts to admin channel, all alerts to general channel:

```env
# Admin channel - gets all notifications
NOTIFICATION_1_TYPE=discord
NOTIFICATION_1_URL=https://discord.com/api/webhooks/.../admin

# General channel - custom cooldown
NOTIFICATION_2_TYPE=discord
NOTIFICATION_2_URL=https://discord.com/api/webhooks/.../general
NOTIFICATION_2_COOLDOWN=600000  # 10 minutes
```

### Mixed Platform Setup

Combine Discord, frontend, and future platforms:

```env
# Discord for ops team
NOTIFICATION_1_TYPE=discord
NOTIFICATION_1_URL=https://discord.com/api/webhooks/...

# Frontend for dashboard
NOTIFICATION_2_TYPE=frontend
NOTIFICATION_2_URL=https://dashboard.example.com
NOTIFICATION_2_WEBHOOK_ID=dashboard-webhook

# Future: Slack for management
NOTIFICATION_3_TYPE=slack
NOTIFICATION_3_URL=https://hooks.slack.com/services/...
```

## Contributing

When adding new platform adapters:

1. Create adapter file following naming convention: `platformname.mjs`
2. Export a class with `send()` method
3. Include proper error handling and logging
4. Add validation for platform-specific URLs
5. Update this README with setup instructions
6. Add configuration examples

## License

Same as parent project.