const { render, html } = require('./html');
const { store } = require('./store');
const { App } = require('./App');

const savedGroqKey = localStorage.getItem('groq_api_key');
if (savedGroqKey) store.setState({ groqApiKey: savedGroqKey });

const savedCerebrasKey = localStorage.getItem('cerebras_api_key');
if (savedCerebrasKey) store.setState({ cerebrasApiKey: savedCerebrasKey });

render(html`<${App} store=${store} />`, document.getElementById('root'));
