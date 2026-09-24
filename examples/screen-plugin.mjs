// Explicitly enable this module in .tide/plugins.json to try the plugin contract.
// Address its command as `tide screen contains <session id> <text>`: the CLI
// routes the session id and this code runs in that session's host, so `args`
// here holds only what follows the session id. `all: true` says the question
// also makes sense across sessions, so `tide screen contains --all <text>` runs
// it in every matching session and returns one {id, result|error} per session.
export default {
  id: 'screen',
  name: 'Screen query example',
  detect: () => true,
  commands: {
    contains: {
      description: 'Usage: contains <text>. Read-only: report whether the session\'s rendered screen contains the literal text. Returns {id, capturedAt, found}.',
      all: true,
      async run(args, context) {
        if (args.length !== 1) throw Error('contains requires one text argument');
        const snapshot = await context.capture();
        return { id: context.session.id, capturedAt: snapshot.capturedAt, found: snapshot.text.includes(args[0]) };
      },
    },
  },
};
