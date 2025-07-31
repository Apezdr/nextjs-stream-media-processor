# Authentication System Documentation

## Overview

This document explains the authentication capabilities and requirements for the Next.js Stream Media Processor backend API. This information is designed to help frontend developers and AI assistants understand how to properly authenticate requests and handle different user access levels.

## Supported Authentication Methods

The backend accepts **four different authentication methods**. You can use any of these methods to authenticate API requests:

### 1. Mobile Token Header
```javascript
headers: {
  'x-mobile-token': 'your_mobile_token_here'
}
```
- Used for mobile applications
- Highest priority authentication method

### 2. Authorization Bearer Token
```javascript
headers: {
  'Authorization': 'Bearer your_session_token_here'
}
```
- Standard OAuth-style authentication
- Works with session tokens or session IDs

### 3. Session Token Header
```javascript
headers: {
  'x-session-token': 'your_session_token_here'
}
```
- Direct session token authentication
- Alternative to Authorization header

### 4. Session Cookies
```javascript
// Automatically handled by browser
fetch('/api/endpoint', {
  credentials: 'include' // This sends cookies
});
```
- Automatic for web browsers with `credentials: 'include'`
- Supports multiple cookie formats for compatibility:
  - `__Secure-authjs.session-token`
  - `next-auth.session-token`
  - `authjs.session-token`
  - `session-token`

## User Access Levels

The system has a hierarchical access control system:

### Access Level Types

1. **Unauthenticated** - No access to protected endpoints
2. **Unapproved User** - Authenticated but not approved for access
3. **Approved User** - Basic access to standard features
4. **Limited Access User** - Restricted access to certain premium features
5. **Admin User** - Full access to all features and admin functions

### Permission Matrix

| User Type | API Access | Premium Features | Admin Functions |
|-----------|------------|------------------|-----------------|
| Unauthenticated | ❌ | ❌ | ❌ |
| Unapproved | ❌ | ❌ | ❌ |
| Approved | ✅ | ✅ | ❌ |
| Limited Access | ✅ | ❌ | ❌ |
| Admin | ✅ | ✅ | ✅ |

**Note:** Admin users can access all features regardless of other restrictions.

## API Response Structure

### Successful Authentication

When authentication succeeds, the user object is available in the request context:

```javascript
{
  id: "user_id_string",
  email: "user@example.com",
  name: "User Name",
  image: "profile_image_url",
  approved: true,
  limitedAccess: false,
  admin: false
}
```

### Error Responses

#### 401 Unauthorized - No Authentication
```json
{
  "error": "No authentication provided",
  "debug": "Expected Authorization header, x-session-token header, x-mobile-token header, or session cookie",
  "supportedMethods": [
    "Authorization: Bearer <token>",
    "x-session-token: <token>",
    "x-mobile-token: <token>",
    "Cookie: session-token=<token>"
  ],
  "origin": "request_origin"
}
```

#### 401 Unauthorized - Invalid Authentication
```json
{
  "error": "Authentication failed",
  "debug": "No valid session found in headers or cookies"
}
```

#### 403 Forbidden - User Not Approved
```json
{
  "error": "User not approved for access"
}
```

#### 403 Forbidden - Admin Required
```json
{
  "error": "Admin privileges required"
}
```

#### 403 Forbidden - Full Access Required
```json
{
  "error": "Full access required"
}
```

#### 429 Too Many Requests
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

## Rate Limiting

The API implements rate limiting to prevent abuse:

- **Default Limit:** 100 requests per minute per user
- **Tracking:** Based on authenticated user ID, falls back to IP address
- **Response:** 429 status with `retryAfter` indicating wait time in seconds

## Frontend Integration Examples

### Basic API Request (Web)
```javascript
// Using cookies (recommended for web apps)
const response = await fetch('/api/user/profile', {
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json'
  }
});
```

### API Request with Session Token
```javascript
const response = await fetch('/api/user/profile', {
  headers: {
    'x-session-token': sessionToken,
    'Content-Type': 'application/json'
  }
});
```

### Mobile App Request
```javascript
const response = await fetch('/api/user/profile', {
  headers: {
    'x-mobile-token': mobileToken,
    'Content-Type': 'application/json'
  }
});
```

### Generic Authentication Helper
```javascript
const makeAuthenticatedRequest = async (endpoint, options = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  
  // Priority order: mobile token, session token, bearer token
  if (mobileToken) {
    headers['x-mobile-token'] = mobileToken;
  } else if (sessionToken) {
    headers['x-session-token'] = sessionToken;
  } else if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }
  
  return fetch(endpoint, {
    ...options,
    credentials: 'include', // Always include cookies as fallback
    headers: { ...headers, ...options.headers }
  });
};
```

## Endpoint Access Requirements

### Public Endpoints
- No authentication required
- Examples: `/api/status`, public media lists

### Basic Authenticated Endpoints
- Requires any valid authentication
- User must be approved
- Examples: `/api/user/profile`, `/api/media/movies`

### Premium Endpoints
- Requires authentication
- User must NOT have `limitedAccess: true`
- Admin users bypass this restriction
- Examples: High-quality video streams, advanced features

### Admin Endpoints
- Requires authentication
- User must have `admin: true`
- Examples: `/api/admin/*`, user management, system settings

## Error Handling Best Practices

### Authentication Flow
1. **Try Request** - Make API call with available authentication
2. **Check 401** - If unauthorized, prompt for login or refresh token
3. **Check 403** - If forbidden, show appropriate access denied message
4. **Check 429** - If rate limited, implement retry with backoff

### Example Error Handler
```javascript
const handleApiResponse = async (response) => {
  if (response.status === 401) {
    // Authentication required or invalid
    const data = await response.json();
    if (data.supportedMethods) {
      // Show login options based on supported methods
      showLoginDialog(data.supportedMethods);
    }
    throw new Error('Authentication required');
  }
  
  if (response.status === 403) {
    const data = await response.json();
    if (data.error === 'User not approved for access') {
      showMessage('Your account is pending approval');
    } else if (data.error === 'Admin privileges required') {
      showMessage('This feature requires administrator access');
    } else if (data.error === 'Full access required') {
      showMessage('This feature requires premium access');
    }
    throw new Error('Access denied');
  }
  
  if (response.status === 429) {
    const data = await response.json();
    showMessage(`Rate limit exceeded. Try again in ${data.retryAfter} seconds`);
    throw new Error('Rate limited');
  }
  
  return response;
};
```

## Cross-Origin Requests

The backend supports CORS for authenticated requests:

- **Credentials:** Always include `credentials: 'include'` for cookie-based auth
- **Headers:** The following authentication headers are allowed:
  - `Authorization`
  - `x-session-token`
  - `x-mobile-token`
  - `Cookie`

## Security Considerations

### Token Storage
- **Mobile tokens:** Store securely in device keychain/keystore
- **Session tokens:** Store securely, consider refresh mechanisms
- **Cookies:** Browser handles automatically, ensure secure flags

### Request Validation
- Always check response status codes
- Handle authentication failures gracefully
- Implement proper retry logic for rate limits
- Validate user permissions before showing UI elements

### User Experience
- Cache user permission data to avoid redundant checks
- Show appropriate loading states during authentication
- Provide clear feedback for access restrictions
- Implement proper logout/session cleanup

## Common Integration Patterns

### Checking User Permissions
```javascript
const canAccessPremiumFeatures = (user) => {
  return user && user.approved && (!user.limitedAccess || user.admin);
};

const canAccessAdminFeatures = (user) => {
  return user && user.admin;
};

const isAuthenticated = (user) => {
  return user && user.approved;
};
```

### Conditional UI Rendering
```javascript
// Show features based on user access level
{isAuthenticated(user) && (
  <UserDashboard />
)}

{canAccessPremiumFeatures(user) && (
  <PremiumFeatures />
)}

{canAccessAdminFeatures(user) && (
  <AdminPanel />
)}
```

This authentication system provides comprehensive security while maintaining flexibility for different client types and use cases.