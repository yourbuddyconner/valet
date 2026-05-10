import { InMemorySessionStore } from "../src/index.js";
import { runSessionStoreContract } from "../src/test-helpers/index.js";

runSessionStoreContract("InMemorySessionStore", {
  factory: () => new InMemorySessionStore(),
});
