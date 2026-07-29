const { render, html } = require('./html');
const { store } = require('./store');
const { App } = require('./App');

const savedCerebrasKey = localStorage.getItem('cerebras_api_key');
const savedGroqKey     = localStorage.getItem('groq_api_key');
if (savedCerebrasKey) store.setState({ cerebrasApiKey: savedCerebrasKey });
if (savedGroqKey)     store.setState({ groqApiKey: savedGroqKey });

render(html`<${App} store=${store} />`, document.getElementById('root'));
