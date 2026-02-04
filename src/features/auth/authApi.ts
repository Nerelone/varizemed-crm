import { api } from "../../shared/api/client";

export type UserProfile = {
  username: string;
  display_name?: string;
  use_prefix?: boolean;
};

export async function fetchProfile() {
  return api<UserProfile>("/api/user/profile");
}

export async function saveProfile(data: { display_name: string; use_prefix: boolean }) {
  return api<unknown>("/api/user/profile", {
    method: "POST",
    body: data
  });
}
