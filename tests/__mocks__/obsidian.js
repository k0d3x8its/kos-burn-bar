class Plugin {
  async loadData() { return {}; }
  async saveData() {}
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeMockEl();
  }
}

class Setting {
  constructor() {}
  setName()  { return this; }
  setDesc()  { return this; }
  addText(cb) {
    cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => ({}) }) }) });
    return this;
  }
  addToggle(cb) {
    cb({ setValue: () => ({ onChange: () => ({}) }) });
    return this;
  }
}

function makeMockEl() {
  const el = {
    empty:      () => {},
    createEl:   () => makeMockEl(),
    createDiv:  () => makeMockEl(),
    createSpan: () => makeMockEl(),
    textContent: "",
    style: {},
  };
  return el;
}

module.exports = { Plugin, ItemView, PluginSettingTab, Setting };
