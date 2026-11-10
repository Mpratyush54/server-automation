package cmd

import (
	"fmt"
	"os"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/mfa"
	"github.com/spf13/cobra"
)

var mfaDisableUser, mfaDisableDatabase string

var mfaCmd = &cobra.Command{
	Use:   "mfa",
	Short: "Break-glass operations for portal multi-factor authentication",
}

var mfaDisableCmd = &cobra.Command{
	Use:   "disable --user <email>",
	Short: "Remove a user's TOTP factor and recovery codes (works without the API; audit-logged)",
	Long: `Removes the user's authenticator and recovery codes directly in the platform database
(psql inside the PostgreSQL pod in namespace databases) and writes an
auth.mfa.break_glass_disable audit log entry. Use it when no admin can sign in to reset
MFA from the portal. If the user's role requires MFA they enrol again at next login.`,
	Args: cobra.NoArgs,
	RunE: func(c *cobra.Command, _ []string) error {
		hostKubeconfig()
		host, _ := os.Hostname()
		res, err := mfa.BreakGlass{Run: mfa.ExecRunner, Database: mfaDisableDatabase, Host: host}.Disable(mfaDisableUser)
		if err != nil {
			return err
		}
		if res.Removed {
			fmt.Printf("MFA disabled for %s (database %s). The user can sign in with their password and enrol again.\n", mfaDisableUser, res.Database)
		} else {
			fmt.Printf("%s had no MFA factor (database %s); nothing removed. The action was audit-logged.\n", mfaDisableUser, res.Database)
		}
		return nil
	},
}

func init() {
	mfaDisableCmd.Flags().StringVar(&mfaDisableUser, "user", "", "email of the user (required)")
	mfaDisableCmd.Flags().StringVar(&mfaDisableDatabase, "database", "", "platform database name (default: POSTGRES_DB from the platform-env Secret, else platform)")
	_ = mfaDisableCmd.MarkFlagRequired("user")
	mfaCmd.AddCommand(mfaDisableCmd)
}
