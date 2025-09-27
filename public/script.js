/* script.js - frontend integration with /generate-quiz backend */

let quizData = [];               // array of {question, options[], answer_index, explanation}
let currentQuestionIndex = 0;
let selectedAnswers = [];        // store selected option index
let score = 0;
let timeLeft = 30;
let timerHandle = null;
let quizStartTime = null;

let previousQuestions = [];      // store question texts to avoid duplicates
let currentTopic = '';
let currentCount = 5;

// DOM refs
const sections = {
  home: document.getElementById('home'),
  quiz: document.getElementById('quiz'),
  results: document.getElementById('results')
};

// Modal refs
const modal = {
  container: document.getElementById('quizSetupModal'),
  topic: document.getElementById('quizTopic'),
  count: document.getElementById('questionCount'),
  startBtn: document.getElementById('startQuizBtn'),
  cancelBtn: document.getElementById('cancelQuizBtn'),
  numberUp: document.querySelector('.number-up'),
  numberDown: document.querySelector('.number-down')
};

const els = {
  questionText: document.getElementById('question-text'),
  optionsContainer: document.getElementById('options-container'),
  currentQuestion: document.getElementById('current-question'),
  totalQuestions: document.getElementById('total-questions'),
  progressFill: document.querySelector('.progress-fill'),
  timerText: document.getElementById('timer-text'),
  finalScore: document.getElementById('final-score'),
  correctAnswers: document.getElementById('correct-answers'),
  wrongAnswers: document.getElementById('wrong-answers'),
  timeTaken: document.getElementById('time-taken')
};

function showSection(name) {
  Object.values(sections).forEach(s => s.classList.remove('active'));
  sections[name].classList.add('active');
  // update nav active classes if present
  document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
  const nav = document.querySelector(`.nav-link[href="#${name}"]`);
  if (nav) nav.classList.add('active');
}

// attach button events
document.getElementById('startBtn').addEventListener('click', startQuiz);
document.getElementById('prevBtn').addEventListener('click', previousQuestion);
document.getElementById('nextBtn').addEventListener('click', nextQuestion);
document.getElementById('moreBtn').addEventListener('click', generateMoreQuestions);
document.getElementById('tryAgainBtn').addEventListener('click', restartQuiz);
document.getElementById('backHomeBtn').addEventListener('click', () => showSection('home'));

// Modal control functions
function showModal() {
  modal.container.classList.add('active');
  modal.topic.value = currentTopic || '';
  modal.count.value = currentCount || 5;
}

function hideModal() {
  modal.container.classList.remove('active');
}

// Handle number input controls
modal.numberUp.addEventListener('click', () => {
  const val = parseInt(modal.count.value, 10) || 5;
  modal.count.value = Math.min(20, val + 1);
});

modal.numberDown.addEventListener('click', () => {
  const val = parseInt(modal.count.value, 10) || 5;
  modal.count.value = Math.max(1, val - 1);
});

// Handle modal buttons
modal.startBtn.addEventListener('click', async () => {
  const topic = modal.topic.value.trim();
  const count = parseInt(modal.count.value, 10) || 5;
  
  if (!topic) {
    modal.topic.focus();
    return;
  }
  if (count < 1 || count > 20) {
    modal.count.focus();
    return;
  }
  
  hideModal();
  await initQuiz(topic, count);
});

modal.cancelBtn.addEventListener('click', hideModal);

// Show setup modal when Start Quiz is clicked
function startQuiz() {
  showModal();
}

// Initialize quiz with given topic and count
async function initQuiz(topic, count) {

  // reset state
  currentTopic = topic;
  currentCount = count;
  previousQuestions = [];
  quizData = [];
  currentQuestionIndex = 0;
  selectedAnswers = [];
  
  // Show loading state
  showSection('quiz');
  els.questionText.textContent = 'Generating your quiz...';
  els.optionsContainer.innerHTML = '';
  score = 0;

  // fetch and start
  const ok = await fetchAndAppendQuestions(currentTopic, currentCount);
  if (!ok) return; // fetch failed
  quizStartTime = new Date();
  showSection('quiz');
  renderQuestion();
  startTimer();
}

// Build usedQuestionsText from previousQuestions to send to server to avoid duplicates
function buildUsedQuestionsText() {
  if (!previousQuestions.length) return '';
  // Sent in a sentence to the model
  return 'Do NOT repeat these exact questions: ' + previousQuestions.map(q => q.replace(/\n/g, ' ')).join(' || ');
}

// fetch questions from server and append unique ones
async function fetchAndAppendQuestions(topic, count) {
  showLoading(true, 'Generating questions…');
  try {
    const payload = {
      topic,
      count,
      usedQuestionsText: buildUsedQuestionsText()
    };
    const resp = await fetch('/generate-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data && (data.error || data.message) ? (data.error || data.message) : 'Server error';
      alert('Failed to generate quiz: ' + err);
      showLoading(false);
      return false;
    }

    const arr = data.questions || data.quiz || [];
    if (!Array.isArray(arr) || arr.length === 0) {
      alert('Server returned no questions.');
      showLoading(false);
      return false;
    }

    // Append only new ones (by question text)
    let added = 0;
    for (const q of arr) {
      const qtext = (q.question || '').trim();
      if (!qtext) continue;
      const dup = quizData.some(existing => existing.question.trim() === qtext) || previousQuestions.includes(qtext);
      if (dup) continue;
      // normalize fields
      const options = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
      const answer_index = typeof q.answer_index === 'number' ? q.answer_index : (typeof q.answerIndex === 'number' ? q.answerIndex : (typeof q.correct === 'number' ? q.correct : 0));
      quizData.push({
        question: qtext,
        options,
        answer_index: Math.max(0, Math.min(3, answer_index)),
        explanation: q.explanation || ''
      });
      previousQuestions.push(qtext);
      added++;
    }

    if (added === 0) {
      // As fallback, if server returned duplicates only, but we still have some quizData (maybe initial),
      // let it be; otherwise inform user.
      if (quizData.length === 0) {
        alert('No new unique questions were generated for that topic. Try a different topic.');
        showLoading(false);
        return false;
      } else {
        console.warn('Server returned duplicates; no new questions added.');
      }
    }

    // update total in UI
    document.getElementById('total-questions').textContent = String(quizData.length);
    showLoading(false);
    return true;
  } catch (err) {
    console.error('Fetch error', err);
    alert('Network error while generating quiz.');
    showLoading(false);
    return false;
  }
}

// Show loading overlay or message (simple)
function showLoading(on, message='') {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  if (on) {
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('active');
    els.questionText.textContent = message || 'Loading...';
    els.optionsContainer.innerHTML = '';
  } else {
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('active');
  }
}

// Render the current question
function renderQuestion() {
  if (!quizData || quizData.length === 0) {
    els.questionText.textContent = 'No questions loaded. Click Start Quiz to generate.';
    els.optionsContainer.innerHTML = '';
    return;
  }

  const q = quizData[currentQuestionIndex];
  els.questionText.textContent = q.question;
  els.optionsContainer.innerHTML = '';

  q.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `<span class="option-letter">${String.fromCharCode(65 + idx)}</span><span class="option-text">${opt}</span>`;
    btn.onclick = () => onOptionClicked(idx);
    els.optionsContainer.appendChild(btn);
  });

  // progress & counters
  els.currentQuestion.textContent = String(currentQuestionIndex + 1);
  els.totalQuestions.textContent = String(quizData.length);
  const progress = ((currentQuestionIndex + 1) / quizData.length) * 100;
  els.progressFill.style.width = `${progress}%`;

  // Reset timer
  resetTimer();
}

// Option clicked handler
function onOptionClicked(index) {
  // prevent multiple clicks
  const buttons = Array.from(document.querySelectorAll('.option-btn'));
  if (buttons.length === 0) return;
  // mark selection visually
  buttons.forEach(b => b.classList.remove('selected'));
  const selectedBtn = buttons[index];
  if (selectedBtn) selectedBtn.classList.add('selected');

  // store choice
  selectedAnswers[currentQuestionIndex] = index;

  // show feedback
  setTimeout(() => showAnswerFeedback(index), 400);
}

// Show correct/incorrect feedback for the current question
function showAnswerFeedback(selectedIndex) {
  const q = quizData[currentQuestionIndex];
  const buttons = Array.from(document.querySelectorAll('.option-btn'));
  // show correct
  if (q.answer_index >= 0 && buttons[q.answer_index]) {
    buttons[q.answer_index].classList.add('correct');
  }
  // show incorrect selection
  if (selectedIndex !== q.answer_index && selectedIndex >= 0 && buttons[selectedIndex]) {
    buttons[selectedIndex].classList.add('incorrect');
  } else if (selectedIndex === q.answer_index) {
    score++;
  }
  // disable further clicks
  buttons.forEach(b => (b.style.pointerEvents = 'none'));

  // move to next question automatically after a short delay
  setTimeout(() => {
    nextQuestion();
  }, 1200);
}

// Next/previous functions
function nextQuestion() {
  stopTimer();
  if (currentQuestionIndex < quizData.length - 1) {
    currentQuestionIndex++;
    renderQuestion();
    startTimer();
  } else {
    finishQuiz();
  }
}

function previousQuestion() {
  if (currentQuestionIndex > 0) {
    stopTimer();
    currentQuestionIndex--;
    renderQuestion();
    startTimer();
  }
}

// Finish quiz and show results
function finishQuiz() {
  stopTimer();
  const endTime = new Date();
  const totalSecs = Math.max(1, Math.floor((endTime - quizStartTime) / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;

  const correct = score;
  const wrong = quizData.length - score;
  const percent = Math.round((score / quizData.length) * 100);

  els.finalScore.textContent = String(percent);
  els.correctAnswers.textContent = String(correct);
  els.wrongAnswers.textContent = String(wrong);
  els.timeTaken.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

  showSection('results');
}

// Timer functions
function startTimer() {
  // initialize
  timeLeft = 30;
  quizStartTime = quizStartTime || new Date();
  updateTimerDisplay();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) {
      // auto mark as no selection (selectedIndex undefined)
      showAnswerFeedback(-1);
    }
  }, 1000);
}

function stopTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function resetTimer() {
  timeLeft = 30;
  updateTimerDisplay();
}

function updateTimerDisplay() {
  els.timerText.textContent = String(timeLeft);
  const circle = document.querySelector('.timer-circle');
  if (!circle) return;
  if (timeLeft <= 10) {
    circle.style.borderColor = 'var(--neon-pink)';
    circle.style.color = 'var(--neon-pink)';
  } else if (timeLeft <= 20) {
    circle.style.borderColor = 'var(--neon-yellow)';
    circle.style.color = 'var(--neon-yellow)';
  } else {
    circle.style.borderColor = 'var(--neon-green)';
    circle.style.color = 'var(--neon-green)';
  }
}

// Generate more questions (append to quizData, avoiding duplicates)
async function generateMoreQuestions() {
  if (!currentTopic) {
    alert('Start a quiz first (choose a topic).');
    return;
  }
  const countInput = prompt('How many additional questions to generate? (1-10):', '5');
  const count = Math.min(20, Math.max(1, parseInt(countInput, 10) || 5));
  const ok = await fetchAndAppendQuestions(currentTopic, count);
  if (ok) {
    alert('New questions added. They will appear at the end of the quiz.');
    // update totals
    document.getElementById('total-questions').textContent = String(quizData.length);
  }
}

// Restart quiz (start over with same topic)
function restartQuiz() {
  // reset but keep topic and previousQuestions so new generation avoids duplicates
  currentQuestionIndex = 0;
  selectedAnswers = [];
  score = 0;
  quizStartTime = new Date();
  // if no questions loaded, fetch initial questions
  if (!quizData || quizData.length === 0) {
    startQuiz();
    return;
  }
  showSection('quiz');
  renderQuestion();
  startTimer();
}

// keyboard support (1-4 select, arrows nav)
document.addEventListener('keydown', (e) => {
  if (!sections.quiz.classList.contains('active')) return;
  if (['1','2','3','4'].includes(e.key)) {
    const num = parseInt(e.key, 10) - 1;
    onOptionClicked(num);
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    nextQuestion();
  } else if (e.key === 'ArrowLeft') {
    previousQuestion();
  }
});

// initialize UI: attach listeners, create particles etc.
function initializeUI() {
  // attach start button already done; just init particle visuals if desired
  // you already have CSS-based particles
  // set initial totals
  document.getElementById('total-questions').textContent = '0';
}

// run init
initializeUI();
