# System Status Monitoring

This module provides system load monitoring and notifications to help prevent degraded user experience during high resource utilization periods.

## Features

- **Real-time system metrics**: CPU, memory, disk usage, process counts
- **Automatic status classification**: normal, elevated, heavy, critical
- **Push notifications**: Alerts frontends when system load becomes problematic
- **Incident tracking**: Maintains history of system issues with memory protection
- **Optimized for scale**: Aggressive caching and rate limiting
- **Multiple frontend support**: Send notifications to multiple frontends

## Configuration

### Environment Variables

The system status module can be configured through environment variables:

```
# Frontend Webhook Configuration
# Multi-frontend approach
FRONT_END_1=https://subdomain.your-domain.com
WEBHOOK_ID_1=321f131x45912w4d9b8c1q1bbd76c9k
FRONT_END_2=http://localhost:3232
WEBHOOK_ID_2=o4jsi82ksjLowQ910PXosEas5S0eopqS
# Add as many frontend/webhook pairs as needed
```

You can configure custom thresholds and monitoring options:
```
# Enable/disable specific resource monitoring
# Set to FALSE to disable monitoring for a specific resource type
SYSTEM_STATUS_MONITOR_CPU=TRUE
SYSTEM_STATUS_MONITOR_MEMORY=TRUE  
SYSTEM_STATUS_MONITOR_DISK=TRUE

# CPU thresholds (percentage)
SYSTEM_STATUS_CPU_ELEVATED=70
SYSTEM_STATUS_CPU_HEAVY=85
SYSTEM_STATUS_CPU_CRITICAL=95

# Memory thresholds (percentage)
SYSTEM_STATUS_MEMORY_ELEVATED=70
SYSTEM_STATUS_MEMORY_HEAVY=80
SYSTEM_STATUS_MEMORY_CRITICAL=90

# Disk thresholds (percentage)
SYSTEM_STATUS_DISK_ELEVATED=80
SYSTEM_STATUS_DISK_HEAVY=90
SYSTEM_STATUS_DISK_CRITICAL=95

# Minimum free disk space in GB before triggering critical warning
SYSTEM_STATUS_MIN_FREE_DISK_GB=5
```

## API Endpoints

### GET /api/system-status

Retrieves current system status and metrics.

**Authentication:**
- Required header: `X-Webhook-ID` with a valid webhook ID

**Response:**
```json
{
  "status": "normal|elevated|heavy|critical",
  "message": "Detailed status message",
  "metrics": {
    "cpu": {
      "usage": "25.4",
      "cores": 8,
      "model": "Intel i7-9700K"
    },
    "memory": {
      "usage": "45.2",
      "total": "16 GB",
      "free": "8.76 GB"
    },
    "disk": {
      "usage": "72.5",
      "io": {
        "read_sec": "1.2 MB",
        "write_sec": "3.5 MB"
      }
    },
    "processes": {
      "total": 120,
      "running": 4
    },
    "loadAverage": [1.2, 1.5, 1.8]
  },
  "incident": {
    "id": "incident-1713996778",
    "startTime": "2025-04-22T22:45:29.000Z",
    "status": "heavy",
    "latestUpdate": "2025-04-22T22:52:10.000Z",
    "message": "System is under heavy load.",
    "updates": [
      {
        "time": "2025-04-22T22:45:29.000Z",
        "status": "heavy",
        "message": "System is under heavy load."
      }
    ]
  },
  "timestamp": "2025-04-22T22:52:10.123Z"
}
```

The response includes:
- `status`: Overall system status classification
- `message`: Human-readable description of the status
- `metrics`: Detailed system metrics
- `incident`: Information about ongoing incidents (if any)
- `timestamp`: When the status was generated

**Headers:**
- `ETag`: For conditional requests
- `Cache-Control`: Caching guidelines
- `X-RateLimit-*`: Rate limiting information

### GET /api/health

Retrieves the last reported system health status (public endpoint).

**Authentication:**
- No authentication required (public endpoint)

**Use Cases:**
- External health monitoring tools
- Public status pages
- Simple uptime checks
- Quick health verification without credentials

**Response:**
```json
{
  "status": "normal|elevated|heavy|critical|unknown|error",
  "message": "System is operating normally.",
  "timestamp": "2025-04-22T22:52:10.123Z",
  "incident": {
    "id": "incident-1713996778",
    "status": "heavy",
    "startTime": "2025-04-22T22:45:29.000Z",
    "latestUpdate": "2025-04-22T22:52:10.000Z",
    "resolvedTime": null
  }
}
```

The response includes:
- `status`: Overall system status classification
- `message`: Human-readable description of the status
- `timestamp`: When the status was last updated
- `incident`: Basic incident information (if any active or recently resolved incident exists)

**Special Status Values:**
- `unknown`: Returned when system health data is not yet available (server just started)
- `error`: Returned when there's an error retrieving health status

**Headers:**
- `Cache-Control`: Caching guidelines (2 minute TTL)
- `Expires`: Cache expiration time

**Notes:**
- This endpoint returns cached data from the last system status check (updated every 60 seconds)
- It does NOT include detailed metrics (CPU, memory, disk details) - use `/api/system-status` for full metrics
- Ideal for lightweight health checks that don't require authentication
- Respects the same cache invalidation as the authenticated endpoint

**Example Usage:**
```javascript
async function checkServerHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    
    if (health.status === 'critical' || health.status === 'heavy') {
      console.warn('Server is experiencing issues:', health.message);
      // Show warning to users or trigger alerts
    }
    
    return health;
  } catch (error) {
    console.error('Failed to check server health:', error);
    return { status: 'error', message: 'Unable to connect to server' };
  }
}
```

### POST /api/trigger-system-status

Manually trigger a system status check and send notifications.

**Authentication:**
- Required header: `X-Webhook-ID` with a valid webhook ID

**Query Parameters:**
- `forceStatus` (optional): Force a specific status for testing notifications

## Memory Optimization

The system includes several memory protection features to ensure stable operation even during prolonged incidents:

1. **Limited Update History**: Incident update arrays are capped at 20 entries to prevent memory bloat during long-running incidents. The system intelligently preserves:
   - The first update entry (incident start)
   - The most recent updates
   - The final resolution update

2. **Incident Cleanup**: Resolved incidents are automatically removed from memory after 30 minutes

3. **Response Caching**: Status responses are cached for 60 seconds to minimize redundant system metric collection

4. **ETag Support**: Clients can use conditional requests to avoid receiving duplicate data

## Frontend Integration

### 1. Receiving Push Notifications

Create an API route on your frontend to receive system status notifications:

```javascript
// pages/api/authenticated/admin/system-status-notification.js
export default async function handler(req, res) {
  // Verify webhook authentication
  const { webhookId } = validateWebhook(req);
  if (!webhookId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const statusData = req.body;
  
  // Store the status information in your state management
  // This could be Redux, Context API, or a database
  await updateSystemStatus(statusData);
  
  // Respond with success
  res.status(200).json({ success: true });
}
```

### 2. Displaying Status to Users

```javascript
function SystemStatusBanner({ status }) {
  if (!status || status === 'normal') return null;
  
  const bannerColors = {
    elevated: 'bg-yellow-100 border-yellow-400 text-yellow-800',
    heavy: 'bg-orange-100 border-orange-400 text-orange-800',
    critical: 'bg-red-100 border-red-400 text-red-800'
  };
  
  return (
    <div className={`border-l-4 p-4 mb-4 ${bannerColors[status] || ''}`}>
      <div className="flex">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="ml-3">
          <p className="text-sm">
            {status === 'critical' && 'Server is experiencing high load. Some operations may be slower than usual.'}
            {status === 'heavy' && 'Server is under load. Some operations may take longer than normal.'}
            {status === 'elevated' && 'Server load is elevated. Performance may be affected.'}
          </p>
        </div>
      </div>
    </div>
  );
}
```

### 3. Polling for Status (optional)

For clients that need to check status periodically:

```javascript
async function fetchSystemStatus() {
  try {
    const response = await fetch('/api/system-status', {
      headers: {
        'X-Webhook-ID': process.env.WEBHOOK_ID_1,
        'If-None-Match': lastEtag // Use for conditional requests
      }
    });
    
    // Handle 304 Not Modified
    if (response.status === 304) {
      return lastStatus;
    }
    
    if (response.ok) {
      const data = await response.json();
      // Store ETag for future requests
      lastEtag = response.headers.get('etag');
      return data;
    }
    
    throw new Error(`Failed to fetch system status: ${response.status}`);
  } catch (error) {
    console.error('Error fetching system status:', error);
    return null;
  }
}
```

## Best Practices

1. **Respect cache headers**: The system includes cache headers to reduce server load. Honor these in your clients.

2. **Use ETags**: Implement conditional requests with `If-None-Match` to avoid unnecessary data transfer.

3. **Consider push over pull**: The push notification approach is more efficient than polling for most use cases.

4. **Progressive enhancement**: Display warnings only for problematic statuses, don't distract users when everything is normal.

5. **Retry strategy**: Implement exponential backoff for status checks during known issues.
