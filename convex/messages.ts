import { v } from "convex/values";

import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";

import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

const populateUser = (ctx: QueryCtx, userId: Id<"users">) => {
  return ctx.db.get(userId);
};

// We are populating member with just a memberId: use an id and load the member.
const populateMember = (ctx: QueryCtx, memberId: Id<"members">) => {
  return ctx.db.get(memberId);
};

// In case we have some replies sent to a message, we have to add that information to each message of that object inside of our array:
const populateThread = async (
  ctx: QueryCtx,
  parentMessageId: Id<"messages">
) => {
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_parent_message_id", (q) =>
      q.eq("parentMessageId", parentMessageId)
    )
    .collect();

  if (messages.length === 0) {
    return {
      count: 0,
      timestamp: 0,
      image: undefined,
      name: "",
    };
  }

  const lastMessage = messages[messages.length - 1];

  const lastMessageMember = await populateMember(ctx, lastMessage.memberId);

  if (!lastMessageMember) {
    return {
      count: 0,
      timestamp: 0,
      image: undefined,
      name: "",
    };
  }

  const lastMessageUser = await populateUser(ctx, lastMessageMember.userId);

  return {
    count: messages.length,
    timestamp: lastMessage._creationTime,
    image: lastMessageUser?.image,
    name: lastMessageUser?.name,
  };
};

const populateReactions = (ctx: QueryCtx, messagId: Id<"messages">) => {
  return ctx.db
    .query("reactions")
    .withIndex("by_message_id", (q) => q.eq("messageId", messagId))
    .collect();
};

// 'getMember' is a combination of user and workspace ids. This is a difference between populating and getting a member.
const getMember = async ({
  ctx,
  userId,
  workspaceId,
}: {
  ctx: QueryCtx;
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
}) => {
  return ctx.db
    .query("members")
    .withIndex("by_workspace_id_user_id", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId)
    )
    .unique();
};

const getConversation = async ({
  ctx,
  memberId,
  workspaceId,
  currentMemberId,
}: {
  ctx: QueryCtx;
  workspaceId: Id<"workspaces">;
  currentMemberId: Id<"members">;
  memberId: Id<"members">;
}) => {
  const existingConversation = await ctx.db
    .query("conversations")
    .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
    .filter((q) =>
      q.or(
        q.and(
          q.eq(q.field("memberOneId"), currentMemberId),
          q.eq(q.field("memberTwoId"), memberId)
        ),
        q.and(
          q.eq(q.field("memberOneId"), memberId),
          q.eq(q.field("memberTwoId"), currentMemberId)
        )
      )
    )
    .unique();

  return existingConversation;
};

export const get = query({
  args: {
    channelId: v.optional(v.id("channels")),
    conversationId: v.optional(v.id("conversations")),
    parentMessageId: v.optional(v.id("messages")),

    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) throw new Error("Unauthorized");

    let _conversationId = args.conversationId;

    if (!args.conversationId && !args.channelId && args.parentMessageId) {
      const parentMessage = await ctx.db.get(args.parentMessageId);

      if (!parentMessage) {
        throw new Error("Parent message not found. Can not get a message");
      }

      _conversationId = parentMessage.conversationId;
    }

    const results = await ctx.db
      .query("messages")
      .withIndex("by_channel_id_parent_message_id_conversation_id", (q) =>
        q
          .eq("channelId", args.channelId)
          .eq("parentMessageId", args.parentMessageId)
          .eq("conversationId", _conversationId)
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      results.page.map(async (message) => {
        const member = await populateMember(ctx, message.memberId);

        const user = member ? await populateUser(ctx, member.userId) : null;

        if (!member || !user) {
          return null;
        }

        const reactions = await populateReactions(ctx, message._id);
        const thread = await populateThread(ctx, message._id);

        const image = message.image
          ? await ctx.storage.getUrl(message.image)
          : undefined;

        const reactionsWithCount = reactions.map((reaction) => {
          return {
            ...reaction,
            count: reactions.filter((r) => r.value === reaction.value).length,
          };
        });

        const dedupedReactions = reactionsWithCount.reduce(
          (acc, reaction) => {
            const existingReaction = acc.find(
              (r) => r.value === reaction.value
            );

            if (existingReaction) {
              existingReaction.memberIds = Array.from(
                new Set([...existingReaction.memberIds, reaction.memberId])
              );
            } else {
              acc.push({ ...reaction, memberIds: [reaction.memberId] });
            }

            return acc;
          },
          [] as (Doc<"reactions"> & {
            count: number;
            memberIds: Id<"members">[];
          })[]
        );

        const reactionsWithoutMemberIdProperty = dedupedReactions.map(
          ({ memberId, ...rest }) => rest
        );

        const updatedForwardedMessage = message.forwardedMessage
          ? { ...message.forwardedMessage }
          : null;

        let updatedMessage = { ...message };

        if (updatedForwardedMessage?.image) {
          const url = (await ctx.storage.getUrl(
            updatedForwardedMessage.image
          )) as Id<"_storage">;

          updatedForwardedMessage.image = url ?? undefined;

          updatedMessage.forwardedMessage = updatedForwardedMessage;
        }

        return {
          ...updatedMessage,
          image,
          member,
          user,
          reactions: reactionsWithoutMemberIdProperty,
          threadCount: thread.count, // Messages' length, those which belongs to given 'parentMessageId'
          threadTimestamp: thread.timestamp, // Message creation date
          threadName: thread.name, // Last message's author's name
          threadImage: thread.image, // Last message's author's img
        };
      })
    );

    const nonNullableMessages = page.filter((message) => message !== null);

    return {
      ...results,
      page: nonNullableMessages,
    };
  },
});

export const getById = query({
  args: { id: v.id("messages") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) return null;

    const message = await ctx.db.get(args.id);

    if (!message) return null;

    // Confirm if a current user which is trying to ACCESS the message, is a member of this workspace or not:

    const currentMember = await getMember({
      ctx,
      userId,
      workspaceId: message.workspaceId,
    });

    if (!currentMember) return null;

    // Question: What if the current user is not a part of a specific channel, in which this message was sent?

    // And this is a member which actually WROTE the message:
    const member = await populateMember(ctx, message.memberId);

    if (!member) {
      return null; // Confirm if a member, who wrote this message exists
    }

    const user = await populateUser(ctx, member.userId);

    if (!user) {
      return null; // Confirm if an user, who wrote this message exists
    }

    const reactions = await populateReactions(ctx, message._id);

    const reactionsWithCount = reactions.map((reaction) => {
      return {
        ...reaction,
        count: reactions.filter((r) => r.value === reaction.value).length,
      };
    });

    const dedupedReactions = reactionsWithCount.reduce(
      (acc, reaction) => {
        const existingReaction = acc.find((r) => r.value === reaction.value);

        if (existingReaction) {
          existingReaction.memberIds = Array.from(
            new Set([...existingReaction.memberIds, reaction.memberId])
          );
        } else {
          acc.push({ ...reaction, memberIds: [reaction.memberId] });
        }

        return acc;
      },
      [] as (Doc<"reactions"> & {
        count: number;
        memberIds: Id<"members">[];
      })[]
    );

    let updatedMessage = { ...message };

    const updatedForwardMessage = updatedMessage?.forwardedMessage
      ? { ...updatedMessage.forwardedMessage }
      : null;

    if (updatedForwardMessage?.image) {
      const url = (await ctx.storage.getUrl(
        updatedForwardMessage.image
      )) as Id<"_storage">;

      updatedForwardMessage.image = url ?? undefined;
      updatedMessage.forwardedMessage = updatedForwardMessage;
    }

    const reactionsWithoutMemberIdProperty = dedupedReactions.map(
      ({ memberId, ...rest }) => rest
    );

    return {
      ...updatedMessage,
      member,
      user,
      reactions: reactionsWithoutMemberIdProperty,
      image: updatedMessage.image
        ? await ctx.storage.getUrl(updatedMessage.image)
        : undefined,
    };
  },
});

export const create = mutation({
  args: {
    body: v.string(),
    image: v.optional(v.id("_storage")),
    workspaceId: v.id("workspaces"),

    channelId: v.optional(v.id("channels")),
    parentMessageId: v.optional(v.id("messages")),
    conversationId: v.optional(v.id("conversations")),
  },

  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) throw new Error("Unauthorized");

    const member = await getMember({
      ctx,
      userId,
      workspaceId: args.workspaceId,
    });

    if (!member) throw new Error("Unauthorized: can not create a message");

    let _conversationId = args.conversationId;

    // We will NOT have conversationId come from the frontend in 1:1.
    // We only have other member's id who we are talking to.

    // Only possible if we are replying in a thread in 1:1 conversation:
    if (!args.conversationId && !args.channelId && args.parentMessageId) {
      const parentMessage = await ctx.db.get(args.parentMessageId);

      if (!parentMessage) throw new Error("Parent message not found");

      _conversationId = parentMessage.conversationId;
    }

    const messageId = await ctx.db.insert("messages", {
      body: args.body,
      memberId: member._id,
      workspaceId: args.workspaceId,

      // Optional properties:
      image: args.image,
      channelId: args.channelId,
      conversationId: _conversationId,
      parentMessageId: args.parentMessageId,
    });

    return messageId;
  },
});

export const forward = mutation({
  args: {
    body: v.optional(v.string()), // One's comment about forwarded message:
    workspaceId: v.id("workspaces"),

    forwardingMessage: v.object({
      id: v.id("messages"),
      authorMemberId: v.id("members"),
    }),

    destination: v.object({
      memberId: v.optional(v.id("members")),
      channelId: v.optional(v.id("channels")),
    }),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) throw new Error("Unauthorized");

    const currentMember = await getMember({
      ctx,
      userId,
      workspaceId: args.workspaceId,
    });

    if (!currentMember) {
      throw new Error("Unauthorized");
    }

    const currentUser = await populateUser(ctx, userId);

    if (!currentUser) {
      throw new Error("User not found");
    }

    const forwardingMessageAuthorMember = await ctx.db.get(
      args.forwardingMessage.authorMemberId
    );

    if (
      !forwardingMessageAuthorMember ||
      forwardingMessageAuthorMember.workspaceId !== args.workspaceId
    ) {
      throw new Error("Author not found");
    }

    const forwardingMessage = await ctx.db.get(args.forwardingMessage.id);

    // TODO: we could forward a forwarded message too (Or maybe we can just edit additional body?)
    if (!forwardingMessage || forwardingMessage.forwardedMessage) {
      throw new Error("Message not found or could not be forwarded");
    }

    if (
      forwardingMessage.memberId !== forwardingMessageAuthorMember._id ||
      forwardingMessage.workspaceId !== args.workspaceId
    ) {
      throw new Error("Can not forward a message in a current workspace");
    }

    if (!(forwardingMessage.channelId || forwardingMessage.conversationId)) {
      throw new Error("Unknown origin info");
    }

    const forwardedMessageAuthorUser = await ctx.db.get(
      forwardingMessageAuthorMember.userId
    );

    if (!forwardedMessageAuthorUser) {
      throw new Error("User not found");
    }

    let originDetails: {
      id: Id<"channels"> | Id<"conversations">;
      type: "channels" | "conversations";
      name: string;
    } | null = {} as any;

    if (forwardingMessage.channelId) {
      const originChannel = await ctx.db.get(forwardingMessage.channelId);

      if (!originChannel) {
        throw new Error("Origin channel not found");
      }

      originDetails!.id = originChannel._id;
      originDetails!.name = originChannel.name;
      originDetails!.type = "channels";
    } else if (forwardingMessage.conversationId) {
      const originConversation = await ctx.db.get(
        forwardingMessage.conversationId
      );

      if (!originConversation) {
        throw new Error("Origin conversation not found");
      }

      originDetails!.id = originConversation._id;
      originDetails!.name = "Direct messages";
      originDetails!.type = "conversations";
    } else {
      throw new Error("Unknown origin info");
    }

    const commonMessageProperties = {
      body: args.body || "",
      memberId: currentMember._id,
      workspaceId: args.workspaceId,

      forwardedMessage: {
        id: args.forwardingMessage.id,

        body: forwardingMessage.body,
        image: forwardingMessage.image,

        author: {
          memberId: forwardingMessageAuthorMember._id,
          name: forwardedMessageAuthorUser.name ?? "",
          image: forwardedMessageAuthorUser.image ?? undefined,
          role: forwardingMessageAuthorMember.role,
        },

        origin: {
          id: originDetails!.id,
          type: originDetails!.type,
          name: originDetails!.name,
        },

        _creationTime: forwardingMessage._creationTime,

        updatedAt: forwardingMessage.updatedAt,
      },
    };

    if (args.destination.channelId) {
      const channel = await ctx.db.get(args.destination.channelId);

      if (!channel || channel.workspaceId !== args.workspaceId) {
        throw new Error("Destination channel not found");
      }

      const messageId = await ctx.db.insert("messages", {
        ...commonMessageProperties,
        channelId: args.destination.channelId,
      });

      return messageId;
    } else if (args.destination.memberId) {
      const member = await ctx.db.get(args.destination.memberId);

      if (!member || member.workspaceId !== args.workspaceId) {
        throw new Error("Unauthorized");
      }

      const conversation = await getConversation({
        ctx,
        workspaceId: args.workspaceId,
        memberId: member._id,
        currentMemberId: currentMember._id,
      });

      if (conversation) {
        const messageId = await ctx.db.insert("messages", {
          ...commonMessageProperties,
          conversationId: conversation._id,
        });

        return messageId;
      } else {
        const conversationId = await ctx.db.insert("conversations", {
          memberOneId: currentMember._id,
          memberTwoId: member._id,
          workspaceId: args.workspaceId,
        });

        const messageId = await ctx.db.insert("messages", {
          ...commonMessageProperties,
          conversationId,
        });

        return messageId;
      }
    } else {
      throw new Error(
        "Some required fields are incorrect. Double-check your request and try again!"
      );
    }
  },
});

export const update = mutation({
  args: { id: v.id("messages"), body: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) throw new Error("Unauthorized, can not update a message");

    const message = await ctx.db.get(args.id);

    if (!message) throw new Error("Message not found");

    // TODO: need to edit a forwarded message
    if (message.forwardedMessage)
      throw new Error("Can not edit forwarded message");

    const member = await getMember({
      ctx,
      userId,
      workspaceId: message.workspaceId,
    });

    if (!member || member._id !== message.memberId)
      throw new Error("Unauthorized, member not found");

    await ctx.db.patch(args.id, {
      body: args.body,
      updatedAt: Date.now(),
    });

    return args.id;
  },
});

export const remove = mutation({
  args: { id: v.id("messages") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);

    if (!userId) throw new Error("Unauthorized, can not update a message");

    const message = await ctx.db.get(args.id);

    if (!message) throw new Error("Message not found");

    const member = await getMember({
      ctx,
      userId,
      workspaceId: message.workspaceId,
    });

    if (!member || member._id !== message.memberId)
      throw new Error("Unauthorized, member not found");

    await ctx.db.delete(args.id);

    return args.id;
  },
});
