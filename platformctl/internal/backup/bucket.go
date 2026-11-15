package backup

import (
	"context"
	"encoding/xml"
	"net/http"
)

// EnsureBucket creates a missing bucket. Existing buckets must be accessible;
// an authorization failure is never treated as a missing bucket.
func (c *S3Client) EnsureBucket(ctx context.Context) error {
	st, b, err := c.do(ctx, http.MethodHead, "", nil, nil)
	if err == nil && st/100 == 2 {
		return nil
	}
	if err != nil || st != http.StatusNotFound {
		return c.s3Error("check bucket on", st, b, err)
	}
	var body []byte
	region := c.Target.SigningRegion()
	if region != "us-east-1" && region != "auto" {
		body, err = xml.Marshal(struct {
			XMLName  xml.Name `xml:"CreateBucketConfiguration"`
			XMLNS    string   `xml:"xmlns,attr"`
			Location string   `xml:"LocationConstraint"`
		}{XMLNS: "http://s3.amazonaws.com/doc/2006-03-01/", Location: region})
		if err != nil {
			return err
		}
	}
	st, b, err = c.do(ctx, http.MethodPut, "", nil, body)
	if err == nil && st/100 == 2 {
		return nil
	}
	var response struct{ Code string }
	_ = xml.Unmarshal(b, &response)
	if err == nil && st == http.StatusConflict && response.Code == "BucketAlreadyOwnedByYou" {
		return nil
	}
	return c.s3Error("create bucket on", st, b, err)
}
