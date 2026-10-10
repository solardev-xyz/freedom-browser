export function createMcpConnectionsPanel(root, api) {
  const list = root.querySelector('[data-mcp-list]');
  const message = root.querySelector('[data-mcp-message]');
  const form = root.querySelector('form');
  const home = root.querySelector('[data-mcp-home]');
  const add = root.querySelector('[data-mcp-add]');
  function showList() {
    form.hidden = true;
    home.hidden = false;
  }
  add.addEventListener('click', () => {
    home.hidden = true;
    form.hidden = false;
    message.textContent = '';
    form.elements.namedItem('connectionName').focus();
  });
  const pending = new Map();
  let generation = 0;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function render(connections) {
    list.replaceChildren();
    if (!connections.length) list.append(element('p', 'Connect a service to let Freedom Agent use its tools.', 'agent-catalog-status'));
    for (const connection of connections) {
      const card = element('section', '', 'agent-mcp-card');
      const heading = element('div', '', 'agent-card-heading');
      heading.append(element('h4', connection.name), element('span', pending.has(connection.id) ? 'Working…' : ({
        connected: 'Connected', 'needs-auth': 'Sign-in needed', failed: 'Unavailable', disconnected: 'Disconnected',
        connecting: 'Connecting…', 'signing-in': 'Signing in…',
      }[connection.state] || connection.state), 'agent-badge'));
      card.append(heading, element('p', connection.url, 'agent-mcp-url'));
      if (connection.message) card.append(element('p', connection.message, 'agent-catalog-status'));
      const actions = element('div', '', 'agent-config-actions');
      const addButton = (text, action, disabled = false) => {
        const button = element('button', text, 'agent-button secondary');
        button.type = 'button';
        button.disabled = disabled;
        button.addEventListener('click', () => run(action, { id: connection.id }));
        actions.append(button);
      };
      if (pending.get(connection.id)?.action === 'signin' || connection.state === 'signing-in') addButton('Cancel sign-in', 'cancel');
      else {
        if (connection.state === 'needs-auth') addButton('Sign in', 'signin', pending.has(connection.id));
        addButton('Reconnect', 'reconnect', pending.has(connection.id));
        addButton('Disconnect', 'remove', pending.has(connection.id));
      }
      card.append(actions);
      if (connection.tools.length) {
        const details = element('details', '', 'agent-provider-advanced');
        details.append(element('summary', `${connection.tools.length} available ${connection.tools.length === 1 ? 'tool' : 'tools'}`));
        const tools = element('ul', '', 'agent-mcp-tools');
        for (const tool of connection.tools) {
          const item = element('li', '');
          item.append(element('strong', tool.name), element('p', tool.description));
          tools.append(item);
        }
        details.append(tools);
        card.append(details);
      }
      list.append(card);
    }
  }
  let connections = [];
  async function run(action, input = {}) {
    const version = ++generation;
    message.textContent = '';
    if (input.id && action !== 'cancel' && action !== 'list') pending.set(input.id, { action, version });
    form.querySelector('button').disabled = action === 'add';
    form.querySelector('button').textContent = action === 'add' ? 'Connecting…' : 'Connect service';
    render(connections);
    try {
      const response = await api.agentMcpConnections(action, input);
      if (version !== generation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Could not update connections. Try again.');
      connections = response.connections || [];
      if (action === 'add') { form.reset(); showList(); add.focus(); }
    } catch (error) { if (version === generation) message.textContent = error.message; }
    finally {
      if (pending.get(input.id)?.version === version || (action === 'cancel' && pending.get(input.id)?.version < version)) pending.delete(input.id);
      form.querySelector('button').disabled = false;
      form.querySelector('button').textContent = 'Connect service';
      render(connections);
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    run('add', { name: form.elements.namedItem('connectionName').value, url: form.elements.namedItem('connectionUrl').value });
  });
  return {
    open: () => { showList(); add.focus(); return run('list'); },
    back: () => {
      if (form.hidden) return false;
      showList();
      message.textContent = '';
      add.focus();
      return true;
    },
  };
}
