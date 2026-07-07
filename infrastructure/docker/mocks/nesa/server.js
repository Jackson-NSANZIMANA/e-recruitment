const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3101;
let results = {};
try {
  results = JSON.parse(fs.readFileSync(process.env.MOCK_DATA_FILE || '/app/data/results.json', 'utf8'));
} catch { results = require('./data/results.json'); }

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'nesa-mock' }));

app.post('/v1/results/lookup', (req, res) => {
  const { indexNumber, requestId } = req.body;
  const result = results[indexNumber];
  if (!result) {
    return res.json({ status: 'NOT_FOUND', requestId, respondedAt: new Date().toISOString() });
  }
  res.json({
    status: 'FOUND',
    payload: { ...result, verifiedAt: new Date().toISOString() },
    requestId,
    respondedAt: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log(`NESA Mock on port ${PORT}`));
