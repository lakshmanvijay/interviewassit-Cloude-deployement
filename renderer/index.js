const { render, html } = require('./html');
const { store } = require('./store');
const { App } = require('./App');

const savedGroqKey = localStorage.getItem('groq_api_key');
if (savedGroqKey) store.setState({ groqApiKey: savedGroqKey });

render(html`<${App} store=${store} />`, document.getElementById('root'));
