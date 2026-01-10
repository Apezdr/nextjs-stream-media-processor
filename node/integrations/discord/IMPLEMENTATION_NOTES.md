# Discord Bot Implementation Notes

This document captures important lessons learned, gotchas, and best practices discovered during the implementation of Discord bot integration for system monitoring.

## Table of Contents

1. [Express Middleware Ordering Issues](#express-middleware-ordering-issues)
2. [Discord Webhook Events](#discord-webhook-events)
3. [Signature Verification Gotchas](#signature-verification-gotchas)
4. [Rate Limiting Strategies](#rate-limiting-strategies)
11. [Creating Slash Commands](#creating-slash-commands)
12. [Creating Interactive Buttons](#creating-interactive-buttons)
13. [Interaction Response Patterns](#interaction-response-patterns)
5. [DM Permission Handling](#dm-permission-handling)
6. [Bot vs REST API Approaches](#bot-vs-rest-api-approaches)
7. [Preventing Message Duplication](#preventing-message-duplication)
8. [Event Deduplication](#event-deduplication)
9. [Component Structure Differences](#component-structure-differences)
10. [Environment Variable Patterns](#environment-variable-patterns)

---

## Express Middleware Ordering Issues

### Problem
Express's `express.json()` middleware parses request bodies before route handlers execute, converting the raw buffer into a JavaScript object. This corrupts Discord's Ed25519 signature verification which requires the exact raw bytes.

### Symptoms
```javascript
// Body arrives as object instead of Buffer
typeof req.body === 'object'  // true, should be Buffer
Buffer.isBuffer(req.body)     // false, should be true
```

### Solution Options

**Option 1: Conditional Middleware (Preferred)**
```javascript
// In app.mjs
app.use((req, res, next) => {
  if (req.path === '/api/discord/events') {
    return next(); // Skip JSON parsing for Discord webhooks
  }
  express.json({ limit: '30mb' })(req, res, next);
});
```

**Option 2: Route-Level Raw Parsing**
```javascript
// In route file
router.post('/discord/events', express.raw({ type: 'application/json' }), async (req, res) => {
  // req.body is now a Buffer
});
```

**Option 3: Detection and Conversion**
```javascript
// Handle pre-parsed bodies
let rawBody = req.body;
if (!Buffer.isBuffer(rawBody)) {
  rawBody = Buffer.from(JSON.stringify(rawBody), 'utf8');
}
```

⚠️ **Warning**: Option 3 can fail because JSON.stringify() may reorder object keys, changing the byte sequence and invalidating the signature.

---

## Discord Webhook Events

### Event Types and Response Requirements

#### PING Event (Endpoint Validation)
```javascript
{
  "type": 0  // PING type
}
```

**Response Requirements:**
- Status: `204 No Content`
- Header: `Content-Type: application/json`
- Body: Empty
- Timeout: Must respond within 3 seconds

**Common Mistakes:**
❌ Returning `{type: 1}` (that's for Interactions, not Webhook Events)  
❌ Missing `Content-Type` header  
❌ Using 200 status instead of 204  

#### APPLICATION_AUTHORIZED Event
```javascript
{
  "version": 1,
  "application_id": "...",
  "type": 1,  // Event type
  "event": {
    "type": "APPLICATION_AUTHORIZED",
    "timestamp": "2024-10-18T14:42:53.064834",
    "data": {
      "integration_type": 1,  // 0=guild, 1=user
      "user": {
        "id": "123456789",
        "username": "TestUser"
      },
      "scopes": ["applications.commands"]
    }
  }
}
```

**Payload Nesting:**
- Outer: `payload.type` (0 for PING, 1 for events)
- Middle: `payload.event.type` (event name like "APPLICATION_AUTHORIZED")
- Inner: `payload.event.data` (actual event data)

**Common Mistakes:**
❌ Looking for `payload.data.user` directly (missing `event` layer)  
❌ Not handling the nested structure properly  

---

## Signature Verification Gotchas

### How Discord Signatures Work

Discord uses Ed25519 signatures to verify webhook authenticity:

```javascript
const signature = req.get('X-Signature-Ed25519');
const timestamp = req.get('X-Signature-Timestamp');
const rawBody = req.body; // MUST be Buffer

const isValid = await verifyKey(rawBody, signature, timestamp, publicKey);
```

### Critical Requirements

1. **Raw Bytes Required**: The body MUST be the exact bytes Discord sent
2. **No Parsing**: Cannot parse to JSON then stringify back
3. **Key Order Matters**: JSON.stringify() doesn't guarantee key order preservation
4. **UTF-8 Encoding**: If converting string to Buffer, use 'utf8' encoding

### Example of What Breaks Verification

```javascript
// ❌ WRONG - This will fail
const parsed = JSON.parse(req.body);
const bodyString = JSON.stringify(parsed);
const rawBody = Buffer.from(bodyString, 'utf8');
// Signature verification FAILS because key order changed

// ✅ CORRECT - Keep original bytes
const rawBody = req.body; // Already a Buffer from express.raw()
```

### Debugging Signature Issues

```javascript
logger.info(`Body is Buffer: ${Buffer.isBuffer(rawBody)}`);
logger.info(`Body length: ${rawBody.length} bytes`);
logger.info(`First 50 chars: ${rawBody.toString('utf8').substring(0, 50)}`);
```

---

## Rate Limiting Strategies

### Discord Rate Limits

Different endpoints have different limits:
- **Create DM**: ~10 per 10 seconds per user
- **Send Message**: ~5 per 5 seconds per channel
- **Global**: 50 requests per second

### Handling Rate Limit Responses

```javascript
if (response.status === 429) {
  const rateLimitData = await response.json().catch(() => ({}));
  const retryAfter = rateLimitData.retry_after || 'unknown';
  logger.warn(`Rate limited. retry_after=${retryAfter}s`);
  throw new Error(`Rate limited (retry after ${retryAfter}s)`);
}
```

### Bulk Operations Strategy

When sending multiple DMs:

```javascript
for (const user of users) {
  await sendIntroductionDM(user.userId, user.username, config);
  
  // Add delay between sends (unless last user)
  if (user !== users[users.length - 1]) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
```

**Recommended Delays:**
- Between DM creates: 100ms
- Between message sends: 200ms
- After rate limit: Use Discord's `retry_after` value

---

## DM Permission Handling

### Common DM Blocking Scenarios

1. **User has DMs disabled** → 403 Forbidden
2. **User blocked the bot** → 403 Forbidden
3. **No shared servers** (only affects Discord.js, not REST API)

### Handling 403 Errors Gracefully

```javascript
if (response.status === 403) {
  logger.warn(`Cannot DM user ${userId} - DMs disabled or bot blocked`);
  return { success: false, reason: 'dm_blocked' };
}
```

**Don't:**
- ❌ Throw errors for DM blocks (expected behavior)
- ❌ Retry 403 errors (won't succeed)
- ❌ Log as errors (just warnings)

**Do:**
- ✅ Return failure with reason code
- ✅ Log as warning
- ✅ Continue processing other users
- ✅ Track statistics (sent/failed/blocked)

---

## Bot vs REST API Approaches

### Discord.js Client (Bot Approach)

**Pros:**
- Event-driven architecture
- Automatic reconnection
- Cache management
- Easy slash command registration

**Cons:**
- Requires shared server for DMs
- Higher memory usage
- Must be continuously running

**When to Use:**
- Slash commands
- Server join events
- Real-time interactions
- Complex bot logic

### REST API Approach

**Pros:**
- No shared server required for DMs
- Stateless (good for scalability)
- Lower resource usage
- Works in webhook-only scenarios

**Cons:**
- Manual rate limit handling
- No automatic retries
- Need to manage tokens explicitly

**When to Use:**
- Webhook event handlers
- User authorization flows
- Simple notification sending
- Serverless environments

### Hybrid Approach (Our Implementation)

We use **both**:

1. **Discord.js Bot**: Slash commands, interactive buttons, server events
2. **REST API**: Webhook events (APPLICATION_AUTHORIZED), DMs to non-server users

```javascript
// Centralized utility works with both approaches
async function sendIntroductionDM(userId, username, config) {
  // Uses REST API internally
  // Called by both bot.mjs and webhook routes
}
```

---

## Preventing Message Duplication

### The Problem

Multiple sources can trigger intro DM sends:
1. Bot startup (ready event)
2. User authorization (webhook event)
3. Manual triggers (admin actions)

### Solution: SQLite Tracking

```javascript
// Check before sending
const alreadySent = await hasReceivedIntro(db, userId);
if (alreadySent) {
  logger.debug(`User ${userId} already received intro - skipping`);
  return { success: false, reason: 'already_sent' };
}

// Record after successful send
await recordIntroSent(db, userId, username, botTag);
```

### Database Schema

```sql
CREATE TABLE discord_intros (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  sent_at TEXT,
  bot_tag TEXT
);
```

**Key Points:**
- Use user_id as PRIMARY KEY (prevents duplicates)
- Store timestamp for audit trail
- Include bot_tag to track which bot sent it
- Check BEFORE attempting to send (avoid rate limits)

---

## Event Deduplication

### The Problem

Discord may send webhook events multiple times due to:
- Network retries
- Discord internal issues
- Service restarts during event delivery

### Solution: In-Memory Event Tracking

```javascript
const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 1000;

// Create unique ID for event
const eventId = `${eventType}_${event.timestamp}`;

// Check if already processed
if (processedEvents.has(eventId)) {
  logger.debug(`Event ${eventId} already processed`);
  return res.status(204).end();
}

// Add to set
processedEvents.add(eventId);

// Memory management - clean old entries
if (processedEvents.size > MAX_PROCESSED_EVENTS) {
  const toRemove = Array.from(processedEvents).slice(0, MAX_PROCESSED_EVENTS / 2);
  toRemove.forEach(id => processedEvents.delete(id));
}
```

### Production Alternative: Redis

For multi-instance deployments:

```javascript
// Store in Redis with TTL
await redis.setex(`discord_event:${eventId}`, 3600, '1');

// Check before processing
const exists = await redis.exists(`discord_event:${eventId}`);
if (exists) {
  return res.status(204).end();
}
```

---

## Component Structure Differences

### Discord.js Components (Bot)

```javascript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const row = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('check_status')
      .setLabel('Check Server Status')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📊')
  );

await user.send({ embeds: [embed], components: [row] });
```

### REST API Components (Webhooks)

```javascript
const components = [
  {
    type: 1, // ACTION_ROW
    components: [
      {
        type: 2, // BUTTON
        style: 1, // Primary
        label: 'Check Server Status',
        custom_id: 'check_status',
        emoji: { name: '📊' }
      }
    ]
  }
];

await fetch(`${API_URL}/channels/${channelId}/messages`, {
  method: 'POST',
  body: JSON.stringify({ embeds: [embed], components })
});
```

### Centralized Template Pattern

Create templates that work for both:

```javascript
// utils/messageTemplates.mjs
export function createIntroductionComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: 'Check Server Status',
          custom_id: 'check_status',
          emoji: { name: '📊' }
        }
      ]
    }
  ];
}
```

Then convert as needed:

```javascript
// In bot.mjs - convert to builders
const componentsData = createIntroductionComponents();
const row = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId(componentsData[0].components[0].custom_id)
      .setLabel(componentsData[0].components[0].label)
      .setStyle(componentsData[0].components[0].style)
      .setEmoji(componentsData[0].components[0].emoji.name)
  );
```

---

## Environment Variable Patterns

### Single Bot Configuration

```env
DISCORD_BOT_TOKEN=your_token
DISCORD_CLIENT_ID=123456789
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_NOTIFY_USERS=111111111,222222222
SERVER_API_URL=https://your-server.com/node
```

### Multi-Bot Support (Future)

```env
# Bot 1
NOTIFICATION_1_TYPE=discord_bot
NOTIFICATION_1_DISCORD_BOT_TOKEN=token1
NOTIFICATION_1_DISCORD_NOTIFY_USERS=111111111

# Bot 2
NOTIFICATION_2_TYPE=discord_bot
NOTIFICATION_2_DISCORD_BOT_TOKEN=token2
NOTIFICATION_2_DISCORD_NOTIFY_USERS=222222222
```

### Configuration Parsing Pattern

```javascript
function getConfiguredDiscordBots() {
  const bots = [];
  let index = 1;
  
  while (true) {
    const type = process.env[`NOTIFICATION_${index}_TYPE`];
    
    if (!type) break; // No more configs
    
    if (type.toLowerCase() === 'discord_bot') {
      bots.push({
        index,
        token: process.env[`NOTIFICATION_${index}_DISCORD_BOT_TOKEN`] 
               || process.env.DISCORD_BOT_TOKEN,
        notifyUsers: process.env[`NOTIFICATION_${index}_DISCORD_NOTIFY_USERS`] 
                     || process.env.DISCORD_NOTIFY_USERS
      });
    }
    
    index++;
  }
  
  return bots;
}
```

---

## Best Practices Summary

### Security
✅ Always verify webhook signatures  
✅ Use environment variables for secrets  
✅ Remove test endpoints in production  
✅ Validate user IDs before processing  

### Reliability
✅ Handle rate limits gracefully  
✅ Implement retry logic with backoff  
✅ Deduplicate events and messages  
✅ Log failures but continue processing  

### Performance
✅ Use bulk operations with delays  
✅ Cache frequently accessed data  
✅ Implement proper database indexing  
✅ Clean up in-memory caches periodically  

### Maintainability
✅ Centralize common logic  
✅ Use shared templates  
✅ Document gotchas (this file!)  
✅ Add comprehensive logging  

---

## Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid signature` | Body was parsed before verification | Use express.raw() or conditional middleware |
| `403 Forbidden` on DM | User blocked DMs | Handle gracefully, log as warning |
| `429 Rate Limited` | Too many requests | Add delays, respect retry_after |
| `Missing user in event` | Wrong payload structure | Check nested structure (payload.event.data.user) |
| `PING validation fails` | Wrong response format | Return 204 with Content-Type header |
| `Duplicate intros` | No tracking | Implement SQLite tracking |
| `Events processed twice` | No deduplication | Track event IDs in Set/Redis |

---

## Testing Checklist

- [ ] Webhook endpoint validates with Discord Developer Portal
- [ ] PING events return 204 with proper headers
- [ ] APPLICATION_AUTHORIZED events trigger intro DMs
- [ ] Rate limits are handled gracefully
- [ ] DM blocking (403) doesn't throw errors
- [ ] Duplicate events are ignored
- [ ] Intro DMs aren't sent twice to same user
- [ ] Slash commands work in DMs and servers
- [ ] Buttons trigger proper interactions
- [ ] Server identification shows correct URL

---

## Useful Resources

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Webhook Events Documentation](https://discord.com/developers/docs/events/webhook-events)
- [Ed25519 Signature Verification](https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization)

---

## Creating Slash Commands

Slash commands provide a user-friendly interface for bot interactions. Here's everything you need to know about implementing them.

### File Structure

Commands are stored in `node/integrations/discord/commands/` and auto-loaded by the bot:

```
commands/
├── status.mjs      # /status command
├── help.mjs        # /help command
└── ping.mjs        # /ping command
```

### Basic Command Template

```javascript
// commands/mycommand.mjs
import { SlashCommandBuilder } from 'discord.js';
import { createCategoryLogger } from '../../../lib/logger.mjs';

const logger = createCategoryLogger('discordBot:myCommand');

// 1. Define command structure
export const data = new SlashCommandBuilder()
  .setName('mycommand')
  .setDescription('Description of what this command does');

// 2. Implement execution logic
export async function execute(interaction, client) {
  await interaction.reply('Hello from my command!');
}
```

### Command Options

Discord supports various option types:

```javascript
export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Check server status')
  // Boolean option
  .addBooleanOption(option =>
    option
      .setName('detailed')
      .setDescription('Show detailed metrics')
      .setRequired(false)  // Optional
  )
  // String option
  .addStringOption(option =>
    option
      .setName('server')
      .setDescription('Which server to check')
      .setRequired(true)  // Required
      .addChoices(
        { name: 'Production', value: 'prod' },
        { name: 'Staging', value: 'staging' }
      )
  )
  // Integer option
  .addIntegerOption(option =>
    option
      .setName('duration')
      .setDescription('Time period in seconds')
      .setMinValue(1)
      .setMaxValue(3600)
  )
  // User option
  .addUserOption(option =>
    option
      .setName('user')
      .setDescription('User to notify')
  );
```

### Accessing Options in Execute

```javascript
export async function execute(interaction, client) {
  // Get option values with type-safe methods
  const detailed = interaction.options.getBoolean('detailed') ?? false;
  const server = interaction.options.getString('server');
  const duration = interaction.options.getInteger('duration') ?? 60;
  const user = interaction.options.getUser('user');
  
  // Use the values
  logger.info(`Command executed with: detailed=${detailed}, server=${server}`);
}
```

### Command Registration

Commands are automatically registered on bot startup:

1. **Guild-specific** (immediate, for testing):
   ```env
   DISCORD_GUILD_ID=123456789  # Registers in this guild only
   ```

2. **Global** (takes ~1 hour to propagate):
   ```env
   # Don't set DISCORD_GUILD_ID
   ```

### Best Practices for Commands

✅ **Do:**
- Use descriptive command and option names
- Set appropriate option constraints (min/max values)
- Provide helpful descriptions
- Handle all error cases
- Defer long-running operations
- Use ephemeral responses for user-specific data

❌ **Don't:**
- Create duplicate command names
- Use overly generic names (e.g., "get", "set")
- Forget to handle missing optional parameters
- Block the interaction thread for >3 seconds
- Return sensitive data in non-ephemeral responses

### Common Command Patterns

#### Pattern 1: Simple Immediate Response
```javascript
export async function execute(interaction, client) {
  await interaction.reply({
    content: 'Command executed successfully!',
    ephemeral: true  // Only visible to user
  });
}
```

#### Pattern 2: Deferred Response (API Calls)
```javascript
export async function execute(interaction, client) {
  // Defer immediately (bot shows "thinking...")
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Perform long operation
    const data = await fetchData();
    
    // Update deferred reply
    await interaction.editReply({
      content: `Result: ${data}`,
      embeds: [embed]
    });
  } catch (error) {
    await interaction.editReply({
      content: '❌ Operation failed',
      embeds: []
    });
  }
}
```

#### Pattern 3: Multi-Step Interaction
```javascript
export async function execute(interaction, client) {
  // Initial reply
  await interaction.reply({
    content: 'Processing step 1...',
    ephemeral: true
  });
  
  await performStep1();
  
  // Follow-up message
  await interaction.followUp({
    content: 'Step 1 complete! Starting step 2...',
    ephemeral: true
  });
  
  await performStep2();
  
  // Final follow-up
  await interaction.followUp({
    content: '✅ All steps completed!',
    ephemeral: true
  });
}
```

### Command Error Handling

```javascript
export async function execute(interaction, client) {
  try {
    // Command logic here
    await doSomething();
    
  } catch (error) {
    logger.error(`Command error: ${error.message}`);
    
    const errorMessage = {
      content: '❌ An error occurred!',
      ephemeral: true
    };
    
    // Check if we can still reply
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
    }
  }
}
```

---

## Creating Interactive Buttons

Buttons provide quick access to actions without requiring slash commands. They're perfect for navigation and confirmations.

### Button Types and Styles

```javascript
import { ButtonBuilder, ButtonStyle } from 'discord.js';

// Primary (blurple)
const primaryButton = new ButtonBuilder()
  .setCustomId('action_primary')
  .setLabel('Primary Action')
  .setStyle(ButtonStyle.Primary)
  .setEmoji('✅');

// Secondary (gray)
const secondaryButton = new ButtonBuilder()
  .setCustomId('action_secondary')
  .setLabel('Secondary')
  .setStyle(ButtonStyle.Secondary);

// Success (green)
const successButton = new ButtonBuilder()
  .setCustomId('action_success')
  .setLabel('Confirm')
  .setStyle(ButtonStyle.Success)
  .setEmoji('🔄');

// Danger (red)
const dangerButton = new ButtonBuilder()
  .setCustomId('action_danger')
  .setLabel('Delete')
  .setStyle(ButtonStyle.Danger)
  .setEmoji('🗑️');

// Link (gray, opens URL)
const linkButton = new ButtonBuilder()
  .setLabel('Documentation')
  .setStyle(ButtonStyle.Link)
  .setURL('https://example.com/docs')
  .setEmoji('📚');
```

### Creating Action Rows

Buttons must be wrapped in ActionRowBuilder (max 5 buttons per row, max 5 rows per message):

```javascript
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const row1 = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('button_1')
      .setLabel('Option 1')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('button_2')
      .setLabel('Option 2')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('button_3')
      .setLabel('Option 3')
      .setStyle(ButtonStyle.Success)
  );

const row2 = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

// Send with message
await interaction.reply({
  content: 'Choose an option:',
  components: [row1, row2],
  ephemeral: true
});
```

### Button Custom IDs

Custom IDs identify which button was clicked. They must be:
- **Unique** within the message
- **Max 100 characters**
- **Descriptive** for easy handling

```javascript
// ❌ BAD - Not descriptive
.setCustomId('btn1')
.setCustomId('action')

// ✅ GOOD - Clear purpose
.setCustomId('status_simple')
.setCustomId('status_detailed')
.setCustomId('status_refresh_detailed')
.setCustomId('setup_notifications')
```

### Naming Patterns for Custom IDs

Use consistent patterns for related buttons:

```javascript
// Pattern: action_modifier
'status_simple'           // View simple status
'status_detailed'         // View detailed status
'status_refresh_simple'   // Refresh simple view
'status_refresh_detailed' // Refresh detailed view

// Pattern: action_target
'view_help'              // View help
'view_commands'          // View commands
'check_status'           // Check status

// Pattern: resource_action
'notifications_enable'   // Enable notifications
'notifications_disable'  // Disable notifications
'incident_details'       // View incident details
```

### Handling Button Interactions

Button clicks are handled in the `interactionCreate` event:

```javascript
// In events/interactionCreate.mjs
export async function execute(interaction, client) {
  if (interaction.isButton()) {
    const customId = interaction.customId;
    
    switch (customId) {
      case 'check_status':
        await handleCheckStatus(interaction, client);
        break;
        
      case 'status_refresh_simple':
        await handleRefreshSimple(interaction, client);
        break;
        
      case 'view_help':
        await handleViewHelp(interaction, client);
        break;
        
      default:
        logger.warn(`Unknown button: ${customId}`);
        await interaction.reply({
          content: '❓ Unknown button action',
          ephemeral: true
        });
    }
  }
}

async function handleCheckStatus(interaction, client) {
  // Always defer for API calls
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const status = await getSystemStatus();
    
    const embed = new EmbedBuilder()
      .setTitle(`Status: ${status.status}`)
      .setDescription(status.message)
      .setColor(getColorForStatus(status.status));
    
    await interaction.editReply({
      embeds: [embed],
      components: [createButtonRow()]
    });
  } catch (error) {
    await interaction.editReply({
      content: '❌ Failed to fetch status',
      components: []
    });
  }
}
```

### Dynamic Button States

Update buttons based on state:

```javascript
// Disable button after click
const disabledButton = new ButtonBuilder()
  .setCustomId('already_clicked')
  .setLabel('Already Processed')
  .setStyle(ButtonStyle.Secondary)
  .setDisabled(true);

// Update message to disable button
await interaction.update({
  content: 'Action completed!',
  components: [
    new ActionRowBuilder()
      .addComponents(disabledButton)
  ]
});
```

### Button Persistence

⚠️ **Important:** Buttons only work while the bot is running. If the bot restarts:
- Button custom IDs remain in messages
- Clicking them will fail (unless bot handles them on restart)
- Consider this when designing long-lived messages

**Solutions:**
1. Use buttons for temporary interactions only
2. Store button state in database if needed
3. Include "Refresh" buttons to regenerate content

### Button Best Practices

✅ **Do:**
- Use descriptive custom IDs
- Always defer button replies for API calls
- Provide visual feedback (emojis, colors)
- Group related buttons logically
- Limit to 5 buttons per row
- Use consistent naming patterns

❌ **Don't:**
- Create buttons with duplicate custom IDs
- Exceed 100 characters in custom ID
- Forget to handle button in interactionCreate
- Use buttons for permanent state changes
- Mix interaction types in one handler

### Common Button Patterns

#### Pattern 1: Navigation Buttons
```javascript
// Switch between views
const simpleViewRow = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('status_detailed')
      .setLabel('Detailed View')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📈'),
    new ButtonBuilder()
      .setCustomId('status_refresh_simple')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔄')
  );
```

#### Pattern 2: Confirmation Buttons
```javascript
const confirmRow = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('action_confirm')
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId('action_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌')
  );
```

#### Pattern 3: Action + Help
```javascript
const actionRow = new ActionRowBuilder()
  .addComponents(
    new ButtonBuilder()
      .setCustomId('perform_action')
      .setLabel('Perform Action')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('view_help')
      .setLabel('Help')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('❓')
  );
```

---

## Interaction Response Patterns

Understanding how to properly respond to interactions is crucial for a good user experience.

### Response Types

| Method | When to Use | Can Use After |
|--------|-------------|---------------|
| `reply()` | First response to interaction | Nothing |
| `deferReply()` | Need time before replying (>3s) | Nothing |
| `editReply()` | Update deferred/replied message | `reply()` or `deferReply()` |
| `followUp()` | Send additional messages | `reply()` or `editReply()` |
| `update()` | Update button/select menu message | Button/Menu interactions |

### The 3-Second Rule

Discord requires a response within **3 seconds** or the interaction fails. For operations that take longer:

```javascript
export async function execute(interaction, client) {
  // ❌ WRONG - Might timeout
  const data = await slowApiCall();  // 5 seconds
  await interaction.reply({ content: data });
  
  // ✅ CORRECT - Defer first
  await interaction.deferReply({ ephemeral: true });
  const data = await slowApiCall();  // 5 seconds - OK now
  await interaction.editReply({ content: data });
}
```

### Ephemeral vs Public Responses

```javascript
// Ephemeral - Only visible to user who triggered it
await interaction.reply({
  content: 'This is private',
  ephemeral: true
});

// Public - Visible to everyone in channel
await interaction.reply({
  content: 'This is public',
  ephemeral: false  // or omit
});
```

**Use Ephemeral for:**
- User-specific data
- Error messages
- Help text
- Status checks
- Private notifications

**Use Public for:**
- Server announcements
- Shared information
- Bot status messages

### Response State Machine

```javascript
export async function execute(interaction, client) {
  // State 1: Initial (unreplied)
  console.log(interaction.replied);   // false
  console.log(interaction.deferred);  // false
  
  // Transition: reply() or deferReply()
  await interaction.deferReply();
  
  // State 2: Deferred
  console.log(interaction.replied);   // false
  console.log(interaction.deferred);  // true
  
  // Transition: editReply()
  await interaction.editReply({ content: 'Done!' });
  
  // State 3: Replied
  console.log(interaction.replied);   // true
  console.log(interaction.deferred);  // false (consumed)
  
  // Can now use followUp()
  await interaction.followUp({ content: 'Extra info' });
}
```

### Error Handling Pattern

```javascript
export async function execute(interaction, client) {
  try {
    // Your logic here
    await doSomething();
    
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    
    const errorMsg = {
      content: '❌ An error occurred!',
      ephemeral: true
    };
    
    // Handle based on interaction state
    if (interaction.replied || interaction.deferred) {
      // Already replied/deferred - use followUp or editReply
      if (interaction.deferred) {
        await interaction.editReply(errorMsg);
      } else {
        await interaction.followUp(errorMsg);
      }
    } else {
      // Not replied yet - can use reply
      await interaction.reply(errorMsg);
    }
  }
}
```

### Button Update vs Reply

When handling button clicks, choose between `update()` and `reply()`:

```javascript
// update() - Modifies the message containing the button
await interaction.update({
  content: 'Button was clicked!',
  components: []  // Remove buttons
});

// reply() - Sends new message
await interaction.reply({
  content: 'Processing your request...',
  ephemeral: true
});
```

**Use `update()` when:**
- Changing button states
- Showing immediate feedback
- Modifying the original message

**Use `reply()` when:**
- Showing user-specific result
- Keeping original message intact
- Creating new interaction thread

### Complex Interaction Flow Example

```javascript
// Slash command with buttons and deferred responses
export async function execute(interaction, client) {
  // 1. Initial reply with buttons
  await interaction.reply({
    content: 'Choose an option:',
    components: [createButtonRow()],
    ephemeral: true
  });
  
  // Later, button handler:
  case 'option_selected':
    // 2. Defer while loading
    await interaction.deferReply({ ephemeral: true });
    
    // 3. Fetch data
    const data = await fetchData();
    
    // 4. Update deferred reply
    await interaction.editReply({
      content: 'Result:',
      embeds: [createEmbed(data)],
      components: [createNewButtonRow()]
    });
    
    // 5. Optional: Send follow-up
    await interaction.followUp({
      content: 'Additional information...',
      ephemeral: true
    });
    break;
}
```

### Common Response Mistakes

❌ **Replying twice:**
```javascript
await interaction.reply({ content: 'First' });
await interaction.reply({ content: 'Second' });  // ERROR!
```

✅ **Use followUp instead:**
```javascript
await interaction.reply({ content: 'First' });
await interaction.followUp({ content: 'Second' });  // OK
```

❌ **Editing before replying:**
```javascript
await interaction.editReply({ content: 'Edit' });  // ERROR!
```

✅ **Defer or reply first:**
```javascript
await interaction.deferReply();
await interaction.editReply({ content: 'Edit' });  // OK
```

❌ **Not handling timeout:**
```javascript
// Takes 5+ seconds
const data = await verySlowOperation();
await interaction.reply({ content: data });  // Fails after 3s
```

✅ **Defer immediately:**
```javascript
await interaction.deferReply();
const data = await verySlowOperation();
await interaction.editReply({ content: data });  // OK
```

### Timeout Recovery

If an interaction times out, you can't recover it. Prevent this by:

1. **Always defer for slow operations**
2. **Set reasonable timeouts on API calls**
3. **Show progress updates**

```javascript
export async function execute(interaction, client) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Set timeout for API call
    const data = await Promise.race([
      fetchData(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000)
      )
    ]);
    
    await interaction.editReply({ content: `Result: ${data}` });
    
  } catch (error) {
    if (error.message === 'Timeout') {
      await interaction.editReply({
        content: '⏱️ Operation timed out. Please try again.'
      });
    } else {
      await interaction.editReply({
        content: `❌ Error: ${error.message}`
      });
    }
  }
}
```
