const { execSync } = require('child_process');

async function main() {
    // Get access token from gcloud
    const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
    console.log('Got access token:', token.substring(0, 20) + '...');

    const projectId = 'gen-lang-client-0499245477';
    const region = 'us-east5';

    // Test 1: Generate content with Gemini (fix: must use role: user)
    console.log('\n--- Testing Gemini 2.0 Flash ---');
    const genUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/gemini-2.0-flash:generateContent`;
    const genResp = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hello in one word' }] }] }),
        signal: AbortSignal.timeout(15000),
    });
    console.log('Gen status:', genResp.status);
    const genData = await genResp.json();
    if (genResp.ok) {
        console.log('Response:', genData.candidates?.[0]?.content?.parts?.[0]?.text);
    } else {
        console.log('Gen error:', JSON.stringify(genData, null, 2));
    }

    // Test 2: Try Claude models on Vertex in us-east5
    const claudeModels = [
        'claude-3-5-sonnet-v2@20241022',
        'claude-3-5-sonnet@20240620',
        'claude-3-haiku@20240307',
        'claude-3-opus@20240229',
        'claude-3-sonnet@20240229',
    ];
    for (const cm of claudeModels) {
        console.log(`\n--- Testing ${cm} on Vertex ---`);
        const claudeUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${cm}:rawPredict`;
        const claudeResp = await fetch(claudeUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                anthropic_version: 'vertex-2023-10-16',
                max_tokens: 50,
                messages: [{ role: 'user', content: 'Say hello in one word' }],
            }),
            signal: AbortSignal.timeout(15000),
        });
        console.log('Status:', claudeResp.status);
        if (claudeResp.ok) {
            const claudeData = await claudeResp.json();
            console.log('Response:', claudeData.content?.[0]?.text);
            break; // Found a working model
        } else {
            const err = await claudeResp.json().catch(() => ({}));
            console.log('Error:', err.error?.message || JSON.stringify(err));
        }
    }

    // Test 3: Try different regions for Claude
    const regions = ['us-central1', 'europe-west1'];
    for (const r of regions) {
        console.log(`\n--- Testing Claude 3.5 Sonnet v2 in ${r} ---`);
        const url = `https://${r}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${r}/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                anthropic_version: 'vertex-2023-10-16',
                max_tokens: 50,
                messages: [{ role: 'user', content: 'Say hello in one word' }],
            }),
            signal: AbortSignal.timeout(15000),
        });
        console.log('Status:', resp.status);
        if (resp.ok) {
            const data = await resp.json();
            console.log('Response:', data.content?.[0]?.text);
        } else {
            const err = await resp.json().catch(() => ({}));
            console.log('Error:', err.error?.message || JSON.stringify(err));
        }
    }
}

main().catch(e => console.error('Fatal:', e.message));
