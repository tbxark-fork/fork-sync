#!/bin/bash


USERNAME="tbxark-fork"
DELETE_UNTRACKED_BRANCHES="false"

gh repo list $USERNAME --fork --visibility public --json owner,name | jq -r 'map(.owner.login + "/" + .name) | .[]' | while read FORK_REPO; do
    echo "Processing repository: $FORK_REPO"
    SOURCE_REPO=$(gh api "repos/$FORK_REPO" --jq '.parent.full_name')    
    if [ -z "$SOURCE_REPO" ]; then
        echo "Cannot find parent repository for $FORK_REPO, skipping..."
        continue
    fi
    echo "Source repository: $SOURCE_REPO"
    source_branches=$(gh api "repos/$SOURCE_REPO/branches" --jq '.[].name')
    fork_branches=$(gh api "repos/$FORK_REPO/branches" --jq '.[].name')
    echo "$fork_branches" | while read branch; do
        if [ ! -z "$branch" ]; then  
            if ! echo "$source_branches" | grep -q "^${branch}$"; then
                if [ "$DELETE_UNTRACKED_BRANCHES" = "false" ]; then
                    echo "Branch $branch is not in source repository, skipping..."
                else
                    echo "Deleting branch $branch from fork"
                    gh api -X DELETE "repos/$FORK_REPO/git/refs/heads/$branch"
                fi
            fi
        fi
    done
    echo "$source_branches" | while read branch; do
        if [ ! -z "$branch" ]; then  
            if echo "$fork_branches" | grep -q "^${branch}$"; then
                echo "Syncing branch $branch"
                gh repo sync "$FORK_REPO" --branch "$branch" --source "$SOURCE_REPO"
            else
                echo "Creating and syncing new branch $branch"
                sha=$(gh api "repos/$SOURCE_REPO/git/refs/heads/$branch" --jq '.object.sha')
                gh api -X POST "repos/$FORK_REPO/git/refs" -f ref="refs/heads/$branch" -f sha="$sha"
            fi
        fi
    done
    
    echo "Finished processing $FORK_REPO"
    echo "----------------------------------------"
done