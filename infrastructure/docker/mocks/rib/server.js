const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3102;
let records = { flagged_hashes: [], under_investigation_hashes: [] };
try {
  records = JSON.parse(fs.readFileSync(process.env.MOCK_DATA_FILE || '/app/data/records.json', 'utf8'));
} catch { records = require('./data/records.json'); }

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'rib-mock' }));

app.post('/v1/vetting/check', (req, res) => {
  const { nationalIdHash, requestId } = req.body;
  let status = 'CLEAR';
  if (records.flagged_hashes.includes(nationalIdHash)) status = 'HAS_RECORDS';
  if (records.under_investigation_hashes.includes(nationalIdHash)) status = 'UNDER_INVESTIGATION';

  setTimeout(() => {
    res.json({ status, requestId, respondedAt: new Date().toISOString() });
  }, Math.floor(Math.random() * 200) + 100);
});

app.listen(PORT, () => console.log(`RIB Mock on port ${PORT}`));
