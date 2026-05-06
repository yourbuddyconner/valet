import { InMemorySessionStore } from "../src/index.js";
import { runSessionStoreContract } from "./store-contract.js";

runSessionStoreContract("InMemorySessionStore", {
  factory: () => new InMemorySessionStore(),
});
