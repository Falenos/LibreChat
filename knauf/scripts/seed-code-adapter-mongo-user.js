// @ts-check
//
// seed-code-adapter-mongo-user.js
//
// Idempotent mongosh script: creates (or re-grants) a Mongo user for the code-adapter
// scoped to its OWN database, so the adapter stops using the cluster admin credential.
//
// WHY THIS EXISTS — KK20-257 review finding B2.
// `agentic-karl-MONGODB-CONNECTION-STRING` is the Cosmos vCore **admin** user:
//   mongodb+srv://${var.mongodb_admin_username}:${random_password.mongo_vcore_admin.result}@…
//   (agk-infrastructure, terraform/subscription/nonprod/tenant/agentic-karl/mongodb-dev.tf)
// The adapter needs exactly one collection (`code_adapter_files`) and was going to be handed
// every database on the cluster — so a bug in a brand-new service that parses untrusted
// uploads would reach every chat. The Blob half of the same finding was fixed with workload
// identity (agk-infrastructure: container-scoped `Storage Blob Data Contributor`); Mongo has
// no workload-identity path here, so it gets a scoped user instead.
//
// WHY A SEPARATE DATABASE, not a scoped role on `agentic-karl`.
// Mongo's built-in roles are database-scoped, not collection-scoped, so `readWrite` on the
// app's database would still expose every chat collection. The adapter supports `MONGO_DB`
// (`src/config.ts` → `client.db(name)` in `src/store/mongo.ts`), so pointing it at its own
// database makes a plain `readWrite` grant precisely as narrow as it needs to be — no custom
// role to maintain. Its indexes and TTL are created at boot, so the database needs no
// pre-seeding beyond this user.
//
// Usage:
//   # The password is NOT generated here — a script that prints a credential puts it in your
//   # shell history and the terminal scrollback. Generate it, store it, then pass it in.
//   export CODE_ADAPTER_MONGO_PASSWORD="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)"
//   mongosh "<admin-connection-string>" knauf/scripts/seed-code-adapter-mongo-user.js
//
// Then build the adapter's URI from the SAME host as the admin string and store it by hand
// (AGK-* = manually managed, so it never enters Terraform state):
//   az keyvault secret set --vault-name kv-agntkarl-nonprod-001 \
//     --name AGK-CODEAPI-MONGO-URI --value "mongodb+srv://code_adapter:<pwd>@<host>/code_adapter?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false"
//
// …and point the GitOps values at it:
//   externalSecret.secrets.MONGO_URI: AGK-CODEAPI-MONGO-URI
//   configmap.MONGO_DB: "code_adapter"
//
// ⚠️ BEFORE RUNNING ON COSMOS vCORE, CONFIRM THE ROLE IS SUPPORTED.
// Cosmos DB for MongoDB vCore does not implement all of MongoDB's user-management surface,
// and the set of grantable roles has changed across versions. Check first:
//   db.getSiblingDB('admin').runCommand({ rolesInfo: 1, showBuiltinRoles: true })
// If database-scoped `readWrite` is not grantable on your cluster, do NOT widen the grant to
// make this script pass — that defeats its purpose. Fall back to either a dedicated cluster
// for the adapter, or keep the admin string in dev with an explicit, tracked exception and
// fix it before prod. The script fails loudly rather than silently degrading.

// mongosh globals. `print` is already a known global in the shared eslint env,
// so declaring it here would trip no-redeclare — these two are not.
/* global db, printjson, quit */

'use strict';

const USER_NAME = 'code_adapter';
const USER_DB = 'code_adapter';
const ROLES = [{ role: 'readWrite', db: USER_DB }];

// mongosh is Node-based, so process.env is available.
const password = typeof process !== 'undefined' ? process.env.CODE_ADAPTER_MONGO_PASSWORD : null;

if (!password || password.length < 24) {
  print('');
  print('ERROR: CODE_ADAPTER_MONGO_PASSWORD is unset or shorter than 24 characters.');
  print('');
  print(
    '  export CODE_ADAPTER_MONGO_PASSWORD="$(openssl rand -base64 33 | tr -d \'/+=\' | cut -c1-32)"',
  );
  print('');
  print('Deliberately not generated here: a script that prints a credential leaves it in');
  print('shell history and terminal scrollback. Generate it, put it in Key Vault, pass it in.');
  quit(1);
}

const adminDb = db.getSiblingDB('admin');

// Fail loudly if the cluster cannot grant a database-scoped role, rather than quietly
// creating a user with more access than intended. See the warning in the header.
let builtinRoles = [];
try {
  const info = adminDb.runCommand({ rolesInfo: 1, showBuiltinRoles: true });
  builtinRoles = (info.roles || []).map((r) => r.role);
} catch (err) {
  print(`WARNING: could not enumerate roles (${err.message}).`);
  print('Continuing — but verify the grant below actually applied, with:');
  print(`  db.getSiblingDB('admin').getUser('${USER_NAME}')`);
}

if (builtinRoles.length > 0 && !builtinRoles.includes('readWrite')) {
  print('');
  print('ERROR: this cluster does not list `readWrite` as a grantable built-in role.');
  print(`Roles it does list: ${builtinRoles.join(', ')}`);
  print('');
  print('Do NOT widen the grant to make this pass — that removes the point of the script.');
  print('See the fallback options in the header comment.');
  quit(1);
}

const existing = adminDb.getUser(USER_NAME);

if (existing == null) {
  adminDb.runCommand({ createUser: USER_NAME, pwd: password, roles: ROLES });
  print(`Created user "${USER_NAME}" with readWrite on "${USER_DB}" and nothing else.`);
} else {
  // Re-running must converge: reset both the roles and the password, so a rotation is the
  // same operation as a create.
  adminDb.runCommand({ updateUser: USER_NAME, pwd: password, roles: ROLES });
  print(`User "${USER_NAME}" already existed — roles and password reset to the target state.`);
}

// Confirm what the cluster actually stored, not what we asked for.
const finalUser = adminDb.getUser(USER_NAME);
print('');
print('Final state:');
printjson({ user: finalUser.user, roles: finalUser.roles });

const grantedOutsideOwnDb = (finalUser.roles || []).filter((r) => r.db !== USER_DB);
if (grantedOutsideOwnDb.length > 0) {
  print('');
  print('WARNING: this user holds roles outside its own database:');
  printjson(grantedOutsideOwnDb);
  print('That defeats the isolation this script exists to create — investigate before use.');
  quit(1);
}

print('');
print(`OK — "${USER_NAME}" is confined to "${USER_DB}". The app's chats are out of reach.`);
print('Next: store the adapter URI as AGK-CODEAPI-MONGO-URI and set MONGO_DB=code_adapter.');
