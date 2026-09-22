// Explicitly enable this module in .tide/plugins.json to try the plugin contract.
export default {
  id: 'screen',
  detect: () => true,
  commands: {
    contains: {
      description: 'Usage: contains <text> (exactly one literal text argument). Read-only; returns {id, capturedAt, found} for the current rendered screen.',
      async run(context, args) {
        if (args.length !== 1) throw Error('contains requires one text argument');
        const snapshot = await context.capture();
        return { id: context.session.id, capturedAt: snapshot.capturedAt, found: snapshot.text.includes(args[0]) };
      },
    },
  },
};
