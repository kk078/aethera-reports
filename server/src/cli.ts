/**
 * Staff-user CLI (Phase 3 chunk E: "CLI `node server user add <name>`
 * seeding"). Run with:
 *   npm run server:user -- add <username> <password>
 *   npm run server:user -- list
 *   npm run server:user -- passwd <username> <new-password>
 *   npm run server:user -- remove <username>
 *
 * Operates on the SAME `users.db` (under `AETHERA_SERVER_DATA_DIR`) the
 * running server reads — no separate config, no server restart needed
 * for a user to log in with a freshly added account.
 */
import { loadServerConfig } from './config'
import {
  openUsersDb,
  createUser,
  deleteUser,
  findUserByUsername,
  listUsers,
  updateUserPassword
} from './auth/users-db'
import { hashPassword } from './auth/auth-plugin'

function usageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`)
  console.error(
    [
      'Usage:',
      '  node server user add <username> <password>',
      '  node server user passwd <username> <new-password>',
      '  node server user remove <username>',
      '  node server user list',
      '',
      '(equivalently: npm run server:user -- <add|passwd|remove|list> ...)'
    ].join('\n')
  )
  process.exit(message ? 1 : 0)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  // Tolerate being invoked either as `... user add x y` or just `... add x y`
  // (the README's `node server user add <name>` phrasing vs. this script's
  // own direct invocation) — drop a leading literal "user" token if present.
  if (args[0] === 'user') args.shift()

  const [command, ...rest] = args
  if (!command || command === '-h' || command === '--help') usageAndExit()

  const config = loadServerConfig()
  const usersDb = openUsersDb(config.dataDir)

  try {
    switch (command) {
      case 'add': {
        const [username, password] = rest
        if (!username || !password) usageAndExit('add requires <username> <password>')
        if (findUserByUsername(usersDb, username)) {
          usageAndExit(`user "${username}" already exists — use "passwd" to change their password.`)
        }
        createUser(usersDb, username, await hashPassword(password))
        console.log(`Created user "${username}".`)
        break
      }
      case 'passwd': {
        const [username, password] = rest
        if (!username || !password) usageAndExit('passwd requires <username> <new-password>')
        const updated = updateUserPassword(usersDb, username, await hashPassword(password))
        if (!updated) usageAndExit(`no such user "${username}".`)
        console.log(`Updated password for "${username}".`)
        break
      }
      case 'remove': {
        const [username] = rest
        if (!username) usageAndExit('remove requires <username>')
        const removed = deleteUser(usersDb, username)
        if (!removed) usageAndExit(`no such user "${username}".`)
        console.log(`Removed user "${username}".`)
        break
      }
      case 'list': {
        const users = listUsers(usersDb)
        if (users.length === 0) {
          console.log('No users yet.')
        } else {
          for (const user of users) console.log(`${user.username}  (created ${user.createdAt})`)
        }
        break
      }
      default:
        usageAndExit(`unknown command "${command}"`)
    }
  } finally {
    usersDb.close()
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
