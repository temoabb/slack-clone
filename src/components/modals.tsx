"use client";

import { useEffect, useState } from "react";

import CreateWorkspaceModal from "@/features/workspaces/components/CreateWorkspaceModal";
import CreateChannelModal from "@/features/channels/components/create-channel-modal";

export const Modals = () => {
  const [mounted, setMounted] = useState(false);

  // useEffect can only be called once we are doing client side rendering. This will not happen on the server side.

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return (
    <>
      <CreateChannelModal />
      <CreateWorkspaceModal />
    </>
  );
};

// 'server-side rendering' and 'server components' are not the same.
