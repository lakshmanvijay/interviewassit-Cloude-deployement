const { render, html } = require('./html');
const { store } = require('./store');
const { App } = require('./App');

render(html`<${App} store=${store} />`, document.getElementById('root'));
