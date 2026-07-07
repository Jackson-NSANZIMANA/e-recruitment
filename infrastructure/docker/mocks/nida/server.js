/**
 * USRP — NIDA Mock Server
 * Simulates NIDA citizen lookup and biometric match APIs
 * FOR DEVELOPMENT USE ONLY
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3100;
const HMAC_SECRET = process.env.HMAC_SECRET || 'dev_nida_hmac_secret';
const MOCK_DATA_FILE = process.env.MOCK_DATA_FILE || '/app/data/citizens.json';

// Load mock citizens data
let citizens = {};
try {
  citizens = JSON.parse(fs.readFileSync(MOCK_DATA_FILE, 'utf8'));
} catch {
  console.warn('Mock data file not found — using inline test data');
  citizens = require('./data/citizens.json');
}

// HMAC validation middleware
function validateHMAC(req, res, next) {
  const signature = req.headers['x-hmac-signature'];
  const requestId = req.headers['x-request-id'];
  const timestamp = req.headers['x-timestamp'];

  if (!signature || !requestId || !timestamp) {
    return res.status(401).json({ error: 'Missing HMAC headers' });
  }

  // Replay attack prevention: reject requests older than 5 minutes
  const requestTime = new Date(timestamp).getTime();
  const now = Date.now();
  if (Math.abs(now - requestTime) > 300000) {
    return res.status(401).json({ error: 'Request timestamp expired' });
  }

  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nida-mock', version: '1.0.0' });
});

// Citizen lookup
app.post('/v1/citizen/lookup', validateHMAC, (req, res) => {
  const { nationalIdHash, requestId } = req.body;

  if (!nationalIdHash) {
    return res.status(400).json({ error: 'nationalIdHash required' });
  }

  const citizen = citizens[nationalIdHash];

  if (!citizen) {
    return res.json({
      status: 'NOT_FOUND',
      requestId,
      respondedAt: new Date().toISOString()
    });
  }

  // Simulate processing delay (50-200ms)
  const delay = Math.floor(Math.random() * 150) + 50;
  setTimeout(() => {
    res.json({
      status: 'FOUND',
      citizen: {
        nationalIdHash,
        fullName: citizen.fullName,
        dateOfBirth: citizen.dateOfBirth,
        gender: citizen.gender,
        homeDistrict: citizen.homeDistrict,
        homeProvince: citizen.homeProvince,
        registeredPhoneNumber: citizen.registeredPhoneNumber,
        citizenshipStatus: citizen.citizenshipStatus
      },
      requestId,
      respondedAt: new Date().toISOString()
    });
  }, delay);
});

// Biometric match
app.post('/v1/biometric/match', validateHMAC, (req, res) => {
  const { nationalIdHash, requestId } = req.body;
  const citizen = citizens[nationalIdHash];

  if (!citizen) {
    return res.json({
      matched: false,
      matchConfidence: 0,
      matchThreshold: 85.0,
      requestId,
      respondedAt: new Date().toISOString()
    });
  }

  // In development: always match if citizen exists
  // Confidence varies 85-99 to simulate realistic scores
  const confidence = Math.floor(Math.random() * 14) + 85;

  setTimeout(() => {
    res.json({
      matched: true,
      matchConfidence: confidence + (Math.random() * 0.9),
      matchThreshold: 85.0,
      requestId,
      respondedAt: new Date().toISOString()
    });
  }, 100);
});

app.listen(PORT, () => {
  console.log(`NIDA Mock Server running on port ${PORT}`);
  console.log(`Loaded ${Object.keys(citizens).length} mock citizens`);
});
