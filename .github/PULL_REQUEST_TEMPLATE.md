## Summary


## Test plan
- [ ] CI green

## Checklist
- [ ] If adding/changing D1 schema: migration file added in `packages/worker/migrations/`
- [ ] If changing `packages/runner/` or `docker/`: `IMAGE_BUILD_VERSION` bumped in `backend/images/base.py`
- [ ] If adding a new plugin with actions/channels: `make generate-registries` run and output committed
