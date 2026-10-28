import {
  API_CONTRACT_UNAVAILABLE,
  LibraryRepositoryError,
  type BriefImport,
  type InspirationDraft,
  type LibraryRepository,
} from "./types";

function unavailable(): Promise<never> {
  return Promise.reject(
    new LibraryRepositoryError(
      "LIBRARY_API_CONTRACT_UNAVAILABLE",
      API_CONTRACT_UNAVAILABLE,
    ),
  );
}

export const unavailableLibraryRepository: LibraryRepository = {
  load: unavailable,
  createInspiration(_input: InspirationDraft) {
    return unavailable();
  },
  updateInspiration(_id: string, _input: InspirationDraft) {
    return unavailable();
  },
  renameCategory(_id: string, _name: string) {
    return unavailable();
  },
  retireCategory(_id: string) {
    return unavailable();
  },
  importBrief(_input: BriefImport) {
    return unavailable();
  },
  createBriefFromInspiration(_id: string) {
    return unavailable();
  },
};

export function messageFromError(error: unknown): string {
  if (error instanceof LibraryRepositoryError || error instanceof Error) {
    return error.message;
  }
  return "LIBRARY_OPERATION_FAILED: The operation failed without an error message.";
}
