import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';


dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Required Salesforce OAuth Environment Variables
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const SF_API_VERSION = process.env.SF_API_VERSION || 'v66.0';
const SF_OWNER_ID = process.env.SF_OWNER_ID;
const SF_BRANCH_ID = process.env.SF_BRANCH_ID;
const SF_COHORT_ID = process.env.SF_COHORT_ID;

const AUTH_URL = 'https://login.salesforce.com/services/oauth2/authorize';
const TOKEN_URL = 'https://login.salesforce.com/services/oauth2/token';

// -------------------------------
// Step 1: Open Salesforce Login Page
// -------------------------------
// app.get('/', (req, res) => {
//   const loginUrl = `${AUTH_URL}?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
//   open(loginUrl);
//   res.send(`Redirecting to Salesforce login...<br><a href="${loginUrl}">${loginUrl}</a>`);
// });

app.get('/', (req, res) => {
  const loginUrl = `${AUTH_URL}?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.send(`
    <h2>Salesforce Login</h2>
    <p><a href="${loginUrl}" target="_blank">Click here to authenticate with Salesforce</a></p>
    <p>${loginUrl}</p>
  `);
});

// -------------------------------
// Step 2: Callback after login with authorization code
// -------------------------------
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code in callback URL.');
  }

  try {
    const tokenRes = await axios.post(TOKEN_URL, null, {
      params: {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, instance_url } = tokenRes.data;

    global.accessToken = access_token;
    global.instanceUrl = instance_url;
    global.refreshToken = refresh_token;

    res.json({
      message: 'Salesforce authentication successful.',
      access_token,
      refresh_token,
      instance_url
    });
  } catch (err) {
    console.error('🔴 ERROR:', err.response?.data || err.message);
    res.status(500).send('OAuth token exchange failed.');
  }
});

// -------------------------------
// Helper: check auth
// -------------------------------
function getSalesforceSession(res) {
  const access_token = global.accessToken;
  const instance_url = global.instanceUrl;

  if (!access_token || !instance_url) {
    res.status(401).json({
      success: false,
      message: 'Authenticate first by visiting /.'
    });
    return null;
  }

  return { access_token, instance_url };
}

// -------------------------------
// Existing query endpoint
// -------------------------------
app.get('/query', async (req, res) => {
  const session = getSalesforceSession(res);
  if (!session) return;

  const { access_token, instance_url } = session;
  const { objectName, where, limit, fields } = req.query;

  if (!objectName) {
    return res.status(400).send('❌ Missing `objectName` query parameter.');
  }

  try {
    let fieldClause;
    if (!fields) {
      fieldClause = 'Id';
    } else if (fields.toUpperCase() === 'ALL') {
      fieldClause = 'FIELDS(ALL)';
    } else {
      fieldClause = fields;
    }

    let soql = `SELECT ${fieldClause} FROM ${objectName}`;

    if (where) {
      soql += ` WHERE ${where}`;
    }

    soql += ` ORDER BY CreatedDate DESC LIMIT ${limit || 10}`;

    const response = await axios.get(
      `${instance_url}/services/data/${SF_API_VERSION}/query`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
        params: { q: soql }
      }
    );

    res.json(response.data.records);
  } catch (err) {
    console.error('🔴 SOQL error:', err.response?.data || err.message);
    res.status(500).send(`Failed to query ${objectName}.`);
  }
});

// -------------------------------
// Existing generic object fetch endpoint
// -------------------------------
app.get('/object/:objectName/:id', async (req, res) => {
  const session = getSalesforceSession(res);
  if (!session) return;

  const { access_token, instance_url } = session;
  const { objectName, id } = req.params;

  try {
    const response = await axios.get(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${objectName}/${id}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('🔴 Error fetching record:', err.response?.data || err.message);
    res.status(500).send('Failed to fetch object record.');
  }
});

// -------------------------------
// NEW: Create BISD Learner for test scenario
// -------------------------------
app.post('/create-bisd-learner', async (req, res) => {
  const session = getSalesforceSession(res);
  if (!session) return;

  const { access_token, instance_url } = session;
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({
      success: false,
      message: 'Both `name` and `email` are required.'
    });
  }

  if (!SF_BRANCH_ID || !SF_COHORT_ID || !SF_OWNER_ID) {
    return res.status(500).json({
      success: false,
      message: 'Missing SF_BRANCH_ID, SF_COHORT_ID, or SF_OWNER_ID in .env'
    });
  }

  try {
    // IMPORTANT:
    // Replace field API names below if your BISD_Learners__c object uses different ones.
    const learnerPayload = {
      Name: name,
      Email__c: email,
      OwnerId: SF_OWNER_ID,
      SDP_Branch__c: SF_BRANCH_ID,
      SDP_Cohort__c: SF_COHORT_ID
    };

    const response = await axios.post(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/BISD_Learners__c/`,
      learnerPayload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.status(201).json({
      success: true,
      message: 'BISD Learner created successfully.',
      salesforce_record_id: response.data.id,
      payload_sent: learnerPayload
    });
  } catch (err) {
    console.error('🔴 Create BISD Learner error:', err.response?.data || err.message);

    res.status(500).json({
      success: false,
      message: 'Failed to create BISD Learner.',
      error: err.response?.data || err.message
    });
  }
});

// -------------------------------
// Optional test route for browser/manual testing
// -------------------------------
app.get('/test-create-bisd-learner', async (req, res) => {
  const session = getSalesforceSession(res);
  if (!session) return;

  const { access_token, instance_url } = session;

  try {
    const learnerPayload = {
      Name: 'Test Participant',
      Email__c: 'test.abc@gmail.com',
      OwnerId: SF_OWNER_ID,
      SDP_Branch__c: SF_BRANCH_ID,
      SDP_Cohort__c: SF_COHORT_ID
    };

    const response = await axios.post(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/BISD_Learners__c/`,
      learnerPayload,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.status(201).json({
      success: true,
      message: 'Test BISD Learner created successfully.',
      salesforce_record_id: response.data.id,
      payload_sent: learnerPayload
    });
  } catch (err) {
    console.error('🔴 Test create error:', err.response?.data || err.message);

    res.status(500).json({
      success: false,
      message: 'Failed to create test BISD Learner.',
      error: err.response?.data || err.message
    });
  }
});

// -------------------------------
// Start server
// -------------------------------
app.listen(port, () => {
  console.log(`✅ App running: http://localhost:${port}`);
});