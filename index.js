import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

import querystring from 'querystring';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// -------------------------------
// Environment Variables
// -------------------------------
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_API_VERSION = process.env.SF_API_VERSION || 'v66.0';

const SF_OWNER_ID = process.env.SF_OWNER_ID;
const SF_BRANCH_ID = process.env.SF_BRANCH_ID;
const SF_COHORT_ID = process.env.SF_COHORT_ID;

const APP_API_KEY = process.env.APP_API_KEY;

// Private key should be stored in Render env with \n escaped
const SF_PRIVATE_KEY = (process.env.SF_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// -------------------------------
// Validation on startup
// -------------------------------
const requiredEnv = [
  'SF_CLIENT_ID',
  'SF_USERNAME',
  'SF_OWNER_ID',
  'SF_BRANCH_ID',
  'SF_COHORT_ID',
  'APP_API_KEY',
  'SF_PRIVATE_KEY'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnv.join(', '));
}

// -------------------------------
// Helper: Generate Salesforce JWT Access Token
// -------------------------------
async function getSalesforceAccessToken() {
  try {
    const now = Math.floor(Date.now() / 1000);

    const assertion = jwt.sign(
      {
        iss: SF_CLIENT_ID,
        sub: SF_USERNAME,
        aud: SF_LOGIN_URL,
        exp: now + 300
      },
      SF_PRIVATE_KEY,
      { algorithm: 'RS256' }
    );

    const requestBody = querystring.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    });

    const response = await axios.post(
      `${SF_LOGIN_URL}/services/oauth2/token`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('🔴 JWT token error:', error.response?.data || error.message);
    throw error;
  }
}

// -------------------------------
// Helper: Validate API key
// -------------------------------
function validateApiKey(req, res) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== APP_API_KEY) {
    res.status(403).json({
      success: false,
      message: 'Invalid or missing API key.'
    });
    return false;
  }

  return true;
}

// -------------------------------
// Helper: Build Learner Payload
// IMPORTANT:
// Update field API names if your Salesforce object uses different names
// -------------------------------
function buildLearnerPayload(name, email,gender) {
  return {
    Name: name,
    Learner_Email_ID__c: email,
    Learner_Gender__c: gender || "Male", // or dynamic later
    OwnerId: SF_OWNER_ID,
    SDP_Branch__c: SF_BRANCH_ID,
    SDP_Cohort__c: SF_COHORT_ID
  };
}

// -------------------------------
// Health Check
// -------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running.'
  });
});

// -------------------------------
// Root route
// -------------------------------
app.get('/', (req, res) => {
  res.send(`
    <h2>ANN Server Integration</h2>
    <p>JWT-based Salesforce API server is running.</p>
    <p>Available routes:</p>
    <ul>
      <li>GET /health</li>
      <li>POST /create-bisd-learner</li>
      <li>GET /test-create-bisd-learner</li>
      <li>GET /query?objectName=OBJECT&fields=Id,Name&where=Name='Test'</li>
      <li>GET /object/:objectName/:id</li>
    </ul>
  `);
});

// -------------------------------
// Query Salesforce object records
// Protected by API key
// Example:
// /query?objectName=SDP_Branch__c&fields=Id,Name&where=Name='Test'
// -------------------------------
app.get('/query', async (req, res) => {
  if (!validateApiKey(req, res)) return;

  const { objectName, where, limit, fields } = req.query;

  if (!objectName) {
    return res.status(400).json({
      success: false,
      message: 'Missing objectName query parameter.'
    });
  }

  try {
    const { access_token, instance_url } = await getSalesforceAccessToken();

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
        headers: {
          Authorization: `Bearer ${access_token}`
        },
        params: { q: soql }
      }
    );

    return res.status(200).json({
      success: true,
      totalSize: response.data.totalSize,
      done: response.data.done,
      records: response.data.records
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to query Salesforce.',
      error: error.response?.data || error.message
    });
  }
});

// -------------------------------
// Fetch a specific Salesforce object record by ID
// Protected by API key
// Example:
// /object/SDP_Branch__c/a2t4H000000K1ap
// -------------------------------
app.get('/object/:objectName/:id', async (req, res) => {
  if (!validateApiKey(req, res)) return;

  const { objectName, id } = req.params;

  try {
    const { access_token, instance_url } = await getSalesforceAccessToken();

    const response = await axios.get(
      `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${objectName}/${id}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    );

    return res.status(200).json({
      success: true,
      record: response.data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch Salesforce record.',
      error: error.response?.data || error.message
    });
  }
});

// -------------------------------
// Create BISD Learner from request body
// Protected by API key
// Body:
// {
//   "name": "Test Participant",
//   "email": "test.abc@gmail.com"
// }
// -------------------------------
app.post('/create-bisd-learner', async (req, res) => {
  if (!validateApiKey(req, res)) return;

  const { name, email, gender } = req.body;

  if (!name || !email) {
    return res.status(400).json({
      success: false,
      message: 'Both name and email are required.'
    });
  }

  try {
    const { access_token, instance_url } = await getSalesforceAccessToken();

    const learnerPayload = buildLearnerPayload(name, email, gender);

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

    return res.status(201).json({
      success: true,
      message: 'BISD Learner created successfully.',
      salesforce_record_id: response.data.id,
      payload_sent: learnerPayload
    });
  } catch (error) {
    console.error('🔴 Create BISD Learner error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to create BISD Learner.',
      error: error.response?.data || error.message
    });
  }
});

// -------------------------------
// Browser test route
// Protected by API key in query string for quick test
// Example:
// /test-create-bisd-learner?apiKey=YOUR_KEY
// -------------------------------
app.get('/test-create-bisd-learner', async (req, res) => {
  const apiKey = req.query.apiKey;

  if (!apiKey || apiKey !== APP_API_KEY) {
    return res.status(403).json({
      success: false,
      message: 'Invalid or missing apiKey query parameter.'
    });
  }

  try {
    const { access_token, instance_url } = await getSalesforceAccessToken();

    const learnerPayload = buildLearnerPayload('Test Participant', 'test.abc@gmail.com');

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

    return res.status(201).json({
      success: true,
      message: 'Test BISD Learner created successfully.',
      salesforce_record_id: response.data.id,
      payload_sent: learnerPayload
    });
  } catch (error) {
    console.error('🔴 Test create error:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to create test BISD Learner.',
      error: error.response?.data || error.message
    });
  }
});

// -------------------------------
// Start server
// -------------------------------
app.listen(port, () => {
  console.log(`✅ App running on port ${port}`);
});