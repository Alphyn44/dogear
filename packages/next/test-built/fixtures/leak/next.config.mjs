// J4 (#80): the Next production build `check:leak` scans, wired exactly as a user's app would
// be. `withDogear` returns this config untouched outside `next dev`, which is layer 1 under Next
// and the claim the gate tests. `agentRules: false` keeps `next` from writing an AGENTS.md here.
import { withDogear } from 'dogear-next'

export default withDogear({ agentRules: false })
