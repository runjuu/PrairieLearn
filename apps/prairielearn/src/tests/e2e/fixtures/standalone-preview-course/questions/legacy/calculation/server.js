define(['PrairieRandom', 'QServer'], function (PrairieRandom, QServer) {
  const server = new QServer();

  server.getData = function (vid) {
    const random = new PrairieRandom.RandomGenerator(vid);
    const left = random.randInt(1, 5);
    const right = random.randInt(1, 5);
    return {
      params: { left, right },
      trueAnswer: { sum: left + right },
    };
  };

  return server;
});
