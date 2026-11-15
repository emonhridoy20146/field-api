/** Public API of the users module. */
export {
  getUser,
  getUsers,
  listStaff,
  listByRole,
  findForLogin,
  checkPassword,
  changeOwnPassword,
  markLogin,
  loadAuthUser,
  createSystemUser,
  displayName,
  searchUsers,
  type UserView,
} from './service.js';
