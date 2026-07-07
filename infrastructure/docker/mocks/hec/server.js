/**
 * USRP — HEC (Higher Education Council) Mock Server
 * Verifies university degrees and IPRC diplomas
 * FOR DEVELOPMENT USE ONLY
 */
const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3103;
let degrees = {};
try {
  degrees = JSON.parse(
    fs.readFileSync(process.env.MOCK_DATA_FILE || '/app/data/degrees.json', 'utf8')
  );
} catch { degrees = require('./data/degrees.json'); }

app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'hec-mock', version: '1.0.0' });
});

// Degree verification by registration number
app.post('/v1/degree/verify', (req, res) => {
  const { registrationNumber, nationalIdHash, requestId } = req.body;

  if (!registrationNumber || !nationalIdHash) {
    return res.status(400).json({ error: 'registrationNumber and nationalIdHash required' });
  }

  const degree = degrees[registrationNumber];

  if (!degree) {
    return res.json({
      verified: false,
      reason: 'REGISTRATION_NOT_FOUND',
      requestId,
      respondedAt: new Date().toISOString()
    });
  }

  // Verify that the degree belongs to the person presenting it
  if (degree.holderNationalIdHash !== nationalIdHash) {
    return res.json({
      verified: false,
      reason: 'HOLDER_MISMATCH',
      requestId,
      respondedAt: new Date().toISOString()
    });
  }

  const delay = Math.floor(Math.random() * 200) + 100;
  setTimeout(() => {
    res.json({
      verified: true,
      registrationNumber: degree.registrationNumber,
      institutionName: degree.institutionName,
      degreeTitle: degree.degreeTitle,
      educationLevel: degree.educationLevel,
      specialistField: degree.specialistField,
      graduationYear: degree.graduationYear,
      requestId,
      respondedAt: new Date().toISOString()
    });
  }, delay);
});

app.listen(PORT, () => {
  console.log(`HEC Mock Server running on port ${PORT}`);
  console.log(`Loaded ${Object.keys(degrees).length} mock degrees`);
});
