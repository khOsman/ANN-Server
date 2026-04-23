import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import querystring from 'querystring';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL;
const SF_API_VERSION = process.env.SF_API_VERSION || 'v66.0';

const SF_BRANCH_ID = process.env.SF_BRANCH_ID;
const SF_COHORT_ID = process.env.SF_COHORT_ID;
const APP_API_KEY = process.env.APP_API_KEY;

const SF_PRIVATE_KEY = (process.env.SF_PRIVATE_KEY || '').replace(/\\n/g, '\n');

async function getSalesforceAccessToken() {
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

  const body = querystring.stringify({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const response = await axios.post(
    `${SF_LOGIN_URL}/services/oauth2/token`,
    body,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  return response.data;
}

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

function buildLearnerPayload(name, email, gender) {
  return {
    Name: name,
    Learner_Email_ID__c: email,
    Learner_Gender__c: gender || 'Male',
    SDP_Branch__c: SF_BRANCH_ID,
    SDP_Cohort__c: SF_COHORT_ID
  };
}

app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Server is running.' });
});

app.get('/debug-env', (req, res) => {
  res.json({
    hasPrivateKey: !!SF_PRIVATE_KEY,
    startsWith: SF_PRIVATE_KEY ? SF_PRIVATE_KEY.substring(0, 30) : null,
    containsBegin: SF_PRIVATE_KEY ? SF_PRIVATE_KEY.includes('BEGIN PRIVATE KEY') : false,
    containsEnd: SF_PRIVATE_KEY ? SF_PRIVATE_KEY.includes('END PRIVATE KEY') : false,
    SF_LOGIN_URL,
    SF_USERNAME
  });
});

app.get('/test-jwt-token', async (req, res) => {
  try {
    const tokenData = await getSalesforceAccessToken();
    res.json({
      success: true,
      instance_url: tokenData.instance_url,
      has_access_token: !!tokenData.access_token
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

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

    res.status(201).json({
      success: true,
      message: 'BISD Learner created successfully.',
      salesforce_record_id: response.data.id,
      payload_sent: learnerPayload
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create BISD Learner.',
      error: error.response?.data || error.message
    });
  }
});

app.listen(port, () => {
  console.log(`✅ App running on port ${port}`);
});