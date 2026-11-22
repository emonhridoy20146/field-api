/** Public API of the media module. */
export { isUploadedBy } from './service.js';
export { markDeleted as markMediaDeleted, removeNow as removeDeletedMediaFiles, type RemovalBatch, type DeleteInfo as MediaDeleteInfo } from './cloud.js';
