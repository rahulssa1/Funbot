const fs = require('fs');
const path = require('path');
const axios = require('axios');
const zlib = require('zlib');
const chalk = require('chalk');
const OpenAI = require('openai');
const customChalk = new chalk.Instance({ level: 3 });
const green = customChalk.green;
const yellow = customChalk.yellow;
const red = customChalk.red;
const cyan = customChalk.cyan.bold;
const bold = customChalk.bold;
const gray = customChalk.gray;

const OPENAI_API_KEY= "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";
const POLL_INTERVAL_S = 95;
const AI_MAX_RETRIES = 7;
const AI_RETRY_DELAY_S = 5;
const GET_TIMEOUT_S = 7000;
const POST_TIMEOUT_S = 25000;

const NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9,
};

if (!OPENAI_API_KEY) {
    console.error(red(bold('ERROR: Please set the OPENAI_API_KEY environment variable.')));
    process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const api = axios.create({
    headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    },
});

const printBanner = () => {
    const lines = [
        "     Auto Quiz Bot     ",
        "      MRPTech     "
    ];

    const boxColor = cyan;
    const titleColor = yellow;
    const creditColor = green;

    const innerWidth = Math.max(...lines.map(line => line.length));
    const padding = 4;
    const totalWidth = innerWidth + padding;

    console.log(boxColor(`┌${'─'.repeat(totalWidth)}┐`));
    
    const titlePaddingTotal = totalWidth - lines[0].length;
    const titlePaddingLeft = ' '.repeat(Math.floor(titlePaddingTotal / 2));
    const titlePaddingRight = ' '.repeat(Math.ceil(titlePaddingTotal / 2));
    console.log(`${boxColor('│')}${titlePaddingLeft}${titleColor(lines[0])}${titlePaddingRight}${boxColor('│')}`);

    console.log(boxColor(`├${'─'.repeat(totalWidth)}┤`));

    const creditPaddingTotal = totalWidth - lines[1].length;
    const creditPaddingLeft = ' '.repeat(Math.floor(creditPaddingTotal / 2));
    const creditPaddingRight = ' '.repeat(Math.ceil(creditPaddingTotal / 2));
    console.log(`${boxColor('│')}${creditPaddingLeft}${creditColor(lines[1])}${creditPaddingRight}${boxColor('│')}`);

    console.log(boxColor(`└${'─'.repeat(totalWidth)}┘`));
    console.log();
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchQuizState = async (lobbyId) => {
    try {
        const url = `https://ft.games/api/quiz/${lobbyId}/`;
        const response = await api.get(url, {
            timeout: GET_TIMEOUT_S,
            responseType: 'arraybuffer',
            headers: { 'Referer': `https://ft.games/${lobbyId}/quiz/` }
        });
        const encoding = response.headers['content-encoding'];
        const data = encoding === 'br' ? zlib.brotliDecompressSync(response.data) : response.data;
        const decoded = JSON.parse(data.toString('utf8'));
        return { lobbyId, state: decoded, error: null };
    } catch (error) {
        return { lobbyId, state: null, error: error.message };
    }
};

const aiPrompt = (question, options) => {
    const nonAlnumChars = (question.match(/[^a-zA-Z0-9\s]/g) || []).length;
    const isEmojiQuestion = question.length > 0 && nonAlnumChars / question.length > 0.4;
    const questionText = isEmojiQuestion ? `These emojis represent a concept...\n${question}` : question;
    const formattedOptions = options.map((opt, i) => `[${i}] ${opt}`).join('\n');
    return `You are a quiz-solving AI... Answer ONLY as a single digit...\n\nQuestion: ${questionText}\n\nOptions:\n${formattedOptions}`;
};

const askAiForAnswer = async (question, options) => {
    const prompt = aiPrompt(question, options);
    console.log(yellow('\n--- 🤔 Asking OpenAI (Once) ---'));

    for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
            console.log(yellow(`AI request attempt ${attempt}/${AI_MAX_RETRIES}...`));

            // Use OpenAI Chat Completions API with gpt-3.5-turbo
            const completion = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a quiz-solving AI. Reply with ONLY a single non-negative integer (0-based index of the correct option). No words, symbols, or punctuation.'
                    },
                    { role: 'user', content: prompt }
                ],
                temperature: 0
            });

            const aiOutput = (completion.choices?.[0]?.message?.content || '').trim();

            console.log(green('--- 🤖 AI Response ---'));
            console.log(`Raw output: '${aiOutput}'`);

            if (aiOutput) {
                const digitMatch = aiOutput.match(/\b(\d+)\b/);
                if (digitMatch) {
                    const idx = parseInt(digitMatch[1], 10);
                    if (idx >= 0 && idx < options.length) return idx;
                }
                for (const [word, value] of Object.entries(NUM_WORDS)) {
                    if (aiOutput.toLowerCase().includes(word) && value < options.length) {
                        return value;
                    }
                }
            }
        } catch (error) {
            console.error(red(`AI Error: ${error.message}`));
        }
        if (attempt < AI_MAX_RETRIES) await sleep(AI_RETRY_DELAY_S * 1000);
    }
    console.error(red('✖ AI failed to provide a valid answer.'));
    return null;
};

const submitAnswer = async (submitOrder) => {
    const { lobbyId, quizId, answerIndex } = submitOrder;
    try {
        const url = `https://ft.games/api/quiz/${lobbyId}/`;
        const payload = { quiz_id: quizId, sel_idx: answerIndex };
        const response = await api.post(url, payload, { 
            timeout: POST_TIMEOUT_S,
            headers: { 'Referer': `https://ft.games/${lobbyId}/quiz/` }
        });
        const isOk = JSON.stringify(response.data).toLowerCase().includes('ok');
        console.log(green(`✔ Submitted to lobby. Success: ${isOk}`));
    } catch (error) {
        console.error(red(`✖ Submission failed for lobby: ${error.message}`));
    }
};

const main = async () => {
    printBanner();

    let lobbyIds;
    try {
        const dataPath = path.join(__dirname, 'data.txt');
        lobbyIds = fs.readFileSync(dataPath, 'utf8').split('\n').map(id => id.trim()).filter(Boolean);
        if (lobbyIds.length === 0) throw new Error('data.txt is empty.');
        console.log(green(`🚀 Checking ${lobbyIds.length} Account by MRPTech Bot.`));
    } catch (error) {
        console.error(red(bold(`ERROR: Could not read 'data.txt'. Details: ${error.message}`)));
        process.exit(1);
    }
    
    while (true) {
        const timestamp = new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' });
        console.log(`\n${gray(`[${timestamp} UTC] Starting new cycle...`)}`);

        const fetchPromises = lobbyIds.map(id => fetchQuizState(id));
        const results = await Promise.all(fetchPromises);

        const representativeQuiz = results.find(res => res.state?.active && res.state.quiz && res.state.answered_idx === null);

        if (!representativeQuiz) {
            console.log(green('No new quizzes found across all lobbies.'));
            await sleep(POLL_INTERVAL_S * 1000);
            continue;
        }
        
        const { question, options } = representativeQuiz.state.quiz;
        console.log(cyan(`New question found: "${question}"`));
        const solvedAnswerIndex = await askAiForAnswer(question, options);

        if (solvedAnswerIndex !== null) {
            const lobbiesToSubmit = results
                .filter(res => res.state?.active && res.state.quiz?.id === representativeQuiz.state.quiz.id && res.state.answered_idx === null)
                .map(res => ({
                    lobbyId: res.lobbyId,
                    quizId: res.state.quiz.id,
                    answerIndex: solvedAnswerIndex,
                }));

            if (lobbiesToSubmit.length > 0) {
                console.log(cyan(`\n--- Submitting answer [${solvedAnswerIndex}] to ${lobbiesToSubmit.length} lobbies in parallel... ---`));
                const submitPromises = lobbiesToSubmit.map(order => submitAnswer(order));
                await Promise.all(submitPromises);
            }
        } else {
            console.error(red('AI failed to solve the quiz, cannot submit to any lobby.'));
        }
        
        await sleep(POLL_INTERVAL_S * 1000);
    }
};

process.on('SIGINT', () => {
    console.log(yellow('\n\n👋 Closing bot. Goodbye from MRPtech'));
    process.exit(0);
});

main().catch(err => {
    console.error(red('\nAn unexpected error occurred:'), err);
    process.exit(1);
});
