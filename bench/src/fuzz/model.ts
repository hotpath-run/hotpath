// Who answers chat() during a fuzz case. Kept free of imports: the fuzz test's
// mock of @hotpathrun/shared loads it, and anything importing the runtime here
// would wait on that same mock.
export const model: { answer: (prompt: string) => string } = {
  answer: () => "",
};
