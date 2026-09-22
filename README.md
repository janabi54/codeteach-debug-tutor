# CodeTeach — AI Debug Tutor

Socratic debugging coach. Never gives the answer — only asks better questions.

## Quick start
    npm install
    cp .env.example .env
    # fill in ANTHROPIC_API_KEY, or set DEBUG_TUTOR_LLM_DISABLED=true
    npm run dev

## Test the classifier
    npm run test:rules

## Endpoints
- POST /api/debug-tutor/hint
- GET  /api/debug-tutor/weak-spots/:studentId
- GET  /api/admin/health/debug-tutor?hours=24 (needs x-admin-key header)
