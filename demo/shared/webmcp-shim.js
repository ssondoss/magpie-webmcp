/**
 * Tiny safety net for the demo pages.
 *
 * The extension installs a full `navigator.modelContext` at document_start, so
 * this normally does nothing. Without the extension loaded, it keeps the demo
 * pages working (tools register into a local registry you can call from the
 * console via `navigator.modelContext.callTool(name, args)`).
 */
(() => {
  if (document.modelContext && typeof document.modelContext.registerTool === 'function') return;
  if (navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') return;

  const tools = new Map();
  const impl = {
    registerTool(tool) {
      tools.set(tool.name, tool);
      return { unregister: () => tools.delete(tool.name) };
    },
    unregisterTool(name) {
      return tools.delete(name);
    },
    provideContext(context) {
      tools.clear();
      for (const tool of context?.tools ?? []) tools.set(tool.name, tool);
    },
    listTools() {
      return [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      }));
    },
    callTool(name, args) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool "${name}" is not registered`);
      return tool.execute(args ?? {});
    },
  };

  Object.defineProperty(document, 'modelContext', { value: impl, configurable: true, writable: true });
  Object.defineProperty(navigator, 'modelContext', { value: impl, configurable: true, writable: true });
  console.info('[demo] WebMCP shim installed (extension not detected)');
})();
